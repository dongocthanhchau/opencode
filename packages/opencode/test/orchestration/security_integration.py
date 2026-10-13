import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-orch-review-", dir="/tmp"))
HOME = ROOT / "home"
HOME.mkdir()
NOW = int(time.time()*1000)
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME/".config"),
           XDG_DATA_HOME=str(HOME/".local/share"))
RESULTS = []


def cli(db, *args):
    env = dict(ENV, OPENCODE_DB=str(db))
    proc = subprocess.run([BIN, *args, "--pure"], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=90)
    return proc.returncode, (proc.stdout+proc.stderr).strip()


template = ROOT/"template.db"
rc, out = cli(template, "db", "SELECT count(*) FROM migration")
if rc:
    raise RuntimeError(out)


def case(name):
    db = ROOT/(name+".db")
    with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
        src.backup(dst)
    c = sqlite3.connect(db)
    c.execute("PRAGMA foreign_keys=ON")
    for pid in ["review-p", "other-p"]:
        c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
                  (pid, str(ROOT/pid), "[]", NOW, NOW))
    for sid, pid in [("ses_worker","review-p"),("ses_verifier","review-p"),("ses_other","other-p")]:
        c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
                  (sid,pid,sid,str(ROOT/pid),sid,"v1",NOW,NOW))
    c.commit()
    return db,c


def goal(c,gid="goal_review",state="active"):
    c.execute("INSERT INTO cvis_project_goal(id,project_id,title,objective,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
              (gid,"review-p","Review goal","Acceptance must be verified",state,NOW,NOW))


def task(c,tid="task_review",status="verifying",gid=None,acceptance=None,scope=None):
    c.execute("INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,acceptance,scope,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
              (tid,"review-p",gid,tid,"implementer",status,json.dumps(acceptance) if acceptance else None,
               json.dumps(scope) if scope else None,NOW,NOW))


CHECKS = [{"id":"tests","label":"Independent checks passed","weight":100}]


def check(name, ok, evidence):
    item = {"name":name,"pass":bool(ok),"evidence":evidence}
    RESULTS.append(item)
    print(json.dumps(item,ensure_ascii=False),flush=True)


db,c = case("forged-verification")
task(c,acceptance=CHECKS)
c.commit()
vrc,vout = cli(db,"cvis","check-verify","task_review","tests","--session","ses_nonexistent","--verdict","pass")
drc,dout = cli(db,"cvis","task-status","task_review","done")
check("Reject fabricated verifier and absent evidence",vrc!=0 and drc!=0,
      {"verify_rc":vrc,"done_rc":drc,"task_status":c.execute("SELECT status FROM cvis_task").fetchone()[0],"output":vout})

db,c = case("worker-self-verifies")
task(c,acceptance=CHECKS)
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES(?,?,?,?,?,?)",
          ("ses_worker","review-p","implementer","idle",NOW,NOW))
c.commit()
rc,out = cli(db,"cvis","check-verify","task_review","tests","--session","ses_worker","--verdict","pass")
check("Reject worker self-verification",rc!=0,{"rc":rc,"output":out})

db,c = case("goal-premature")
goal(c)
task(c,status="draft",gid="goal_review")
c.commit()
rc,out = cli(db,"cvis","goal-status","goal_review","completed")
check("Reject goal completion with unfinished tasks",rc!=0,{"rc":rc,"output":out})

db,c = case("paused-goal")
goal(c,state="paused")
task(c,status="queued",gid="goal_review")
c.commit()
rc,out = cli(db,"cvis","task-claim","task_review","ses_worker")
check("Paused project goal blocks claims",rc!=0,{"rc":rc,"output":out})

db,c = case("revision-proof")
task(c,acceptance=CHECKS)
c.execute("INSERT INTO cvis_check(id,task_id,check_id,verifier_session,verdict,evidence,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
          ("check_old","task_review","tests","ses_verifier","pass",'{"command":"old-tests","exit_code":0}',NOW,NOW))
c.commit()
rc,out = cli(db,"cvis","task-revise","task_review","--acceptance",json.dumps([
    {"id":"tests","label":"Completely different requirements and test suite","weight":100}]))
prc,pout = cli(db,"cvis","task-progress","task_review")
drc,dout = cli(db,"cvis","task-status","task_review","done")
percent = json.loads(pout)["percent"]
check("Revision invalidates obsolete verification",rc==0 and percent<100 and drc!=0,
      {"revision_rc":rc,"percent":percent,"done_rc":drc})

db,c = case("failed-new-attempt")
task(c,acceptance=CHECKS)
c.execute("INSERT INTO cvis_task_run(id,task_id,session_id,attempt,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
          ("run_old","task_review","ses_worker",1,"done",NOW,NOW))
c.execute("INSERT INTO cvis_task_run(id,task_id,session_id,attempt,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
          ("run_new","task_review","ses_worker",2,"failed",NOW,NOW))
c.execute("INSERT INTO cvis_check(id,task_id,check_id,run_id,verifier_session,verdict,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
          ("old_check","task_review","tests","run_old","ses_verifier","pass",NOW,NOW))
c.commit()
rc,out = cli(db,"cvis","task-status","task_review","done")
check("Latest failed attempt cannot reuse old PASS",rc!=0,{"rc":rc,"output":out})

db,c = case("fake-running-percent")
task(c,status="running")
c.commit()
rc,out = cli(db,"cvis","task-progress","task_review")
check("No unverified 50% for merely running",json.loads(out)["percent"]==0,{"output":out})

db,c = case("symlink-claim")
worktree = ROOT/"review-p"
outside = ROOT/"outside"
worktree.mkdir(exist_ok=True)
outside.mkdir(exist_ok=True)
(worktree/"escape").symlink_to(outside,target_is_directory=True)
task(c,status="queued",scope={"write_paths":["escape"]})
c.commit()
rc,out = cli(db,"cvis","task-claim","task_review","ses_worker")
check("Actual claim rejects symlink escape",rc!=0,{"rc":rc,"symlink_target":str((worktree/"escape").resolve()),"output":out})

db,c = case("cross-project-binding")
task(c,status="queued")
c.commit()
rc,out = cli(db,"cvis","binding-set","ses_other","implementer","--project","review-p","--task","task_review")
check("Binding rejects session from another project",rc!=0,{"rc":rc,"output":out})

db,c = case("paused-session")
task(c,status="queued")
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES(?,?,?,?,?,?)",
          ("ses_worker","review-p","implementer","paused",NOW,NOW))
c.commit()
rc,out = cli(db,"cvis","task-claim","task_review","ses_worker")
check("Paused worker binding blocks claim",rc!=0,{"rc":rc,"output":out})

db,c = case("busy-role-change")
task(c,status="running")
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?)",
          ("ses_worker","review-p","implementer","task_review","busy",NOW,NOW))
c.commit()
rc,out = cli(db,"cvis","binding-set","ses_worker","manager","--project","review-p")
check("Busy worker cannot clear task and become manager",rc!=0,
      {"rc":rc,"binding":c.execute("SELECT role,task_id,status FROM cvis_session_binding").fetchone(),"output":out})

db,c = case("sessionless-run")
task(c,status="draft")
c.commit()
rc,out = cli(db,"cvis","run-start","task_review","ses_nonexistent")
check("Run start cannot bypass dispatch validation",rc!=0,{"rc":rc,"output":out})

db,c = case("forged-message")
rc,out = cli(db,"cvis","message-send","--project","review-p","--from","ses_ghost_manager",
             "--to","ses_worker","--kind","assign","--body",'{"instruction":"forged"}')
check("Messages reject fabricated sender identity",rc!=0,{"rc":rc,"output":out})

db,c = case("cursor-full-boundary")
for i in range(150):
    c.execute("INSERT INTO cvis_event(id,project_id,entity_kind,entity_id,type,sequence,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
              (f"review_event_{i:04d}","review-p","task","task_review","review.event",i+1,NOW,NOW))
c.commit()
rc,p1 = cli(db,"cvis","events","--project","review-p","--limit","100")
rows1 = json.loads(p1)
cursor = rows1[-1]["cursor"]
rc,p2 = cli(db,"cvis","events","--project","review-p","--cursor",str(cursor),"--limit","100")
rows2 = json.loads(p2)
ids = {r["id"] for r in rows1+rows2}
check("Cursor paginates batches larger than limit at same timestamp",len(ids)==150,
      {"page1":len(rows1),"page2":len(rows2),"unique_seen":len(ids),"total":150})

db,c = case("raw-prompt-preserved")
rc,out = cli(db,"cvis","template-render","clarify","--var","request=Keep literal {{other}} unchanged","--var","other=REWRITTEN")
check("Prompt variables do not rewrite raw request placeholders",rc==0 and "{{other}}" in json.loads(out)["text"],
      {"rc":rc,"output":out})

db,c = case("cancel-binding")
task(c,status="queued")
c.commit()
rc,out = cli(db,"cvis","task-claim","task_review","ses_worker")
rc,out = cli(db,"cvis","task-cancel","task_review")
binding = c.execute("SELECT status,task_id FROM cvis_session_binding WHERE session_id='ses_worker'").fetchone()
check("Cancel releases worker binding",binding==("idle",None),{"binding":binding,"cancel_rc":rc})

db,c = case("claim-existing-deny")
deny = {"permission":"edit","pattern":"src/secret/*","action":"deny"}
c.execute("UPDATE session SET permission=? WHERE id='ses_worker'",(json.dumps([deny]),))
task(c,status="queued",scope={"write_paths":["src"]})
c.commit()
rc,out = cli(db,"cvis","task-claim","task_review","ses_worker")
saved = json.loads(c.execute("SELECT permission FROM session WHERE id='ses_worker'").fetchone()[0])
check("Claim preserves existing hard permission deny",rc==0 and deny in saved,
      {"rc":rc,"old_deny_preserved":deny in saved,"stored_permission":saved})

db,c = case("foreign-goal")
goal(c)
c.commit()
rc,out = cli(db,"cvis","task-create","--project","other-p","--goal","goal_review",
             "--title","Wrong project task","--role","researcher")
check("Task rejects project goal owned by another project",rc!=0,{"rc":rc,"output":out})

counts = {"pass":sum(r["pass"] for r in RESULTS),"fail":sum(not r["pass"] for r in RESULTS),"total":len(RESULTS)}
(ROOT/"results.json").write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2))
print("AUDIT_ROOT",ROOT)
print("RESULT",json.dumps(counts))
if counts["fail"]:
    raise SystemExit(1)
