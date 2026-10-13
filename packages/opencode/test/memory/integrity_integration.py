import hashlib
import http.server
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-management-audit-",dir="/tmp"))
HOME=ROOT/"home"
HOME.mkdir()
ENV=dict(os.environ,HOME=str(HOME),XDG_CONFIG_HOME=str(HOME/".config"),XDG_DATA_HOME=str(HOME/".local/share"),OPENCODE_MEMORY_EMBED_URL="http://127.0.0.1:9")
NOW=int(time.time()*1000)
RESULTS=[]


def cli(db,*args,real_embed=False,extra=None):
    env=dict(ENV,OPENCODE_DB=str(db),OPENCODE_MEMORY_VAULT=str(ROOT/"vault"/db.stem))
    if real_embed:env["OPENCODE_MEMORY_EMBED_URL"]="http://127.0.0.1:11434"
    if extra:env.update(extra)
    p=subprocess.run([BIN,*args,"--pure"],cwd=ROOT,env=env,capture_output=True,text=True,timeout=180)
    return p.returncode,(p.stdout+p.stderr).strip()


template=ROOT/"template.db"
rc,out=cli(template,"db","SELECT 1")
if rc:raise RuntimeError(out)


def case(name):
    db=ROOT/(name+".db")
    with sqlite3.connect(template) as src,sqlite3.connect(db) as dst:src.backup(dst)
    c=sqlite3.connect(db)
    for pid in ["p","other"]:
        c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",(pid,str(ROOT/pid),"[]",NOW,NOW))
    c.commit()
    return db,c


def session(c,sid="ses_a",pid="p",summary=None,query=None):
    c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",(sid,pid,sid,str(ROOT),"Shared infrastructure","v1",NOW,NOW))
    for n,text,meta in [(0,summary,{"role":"assistant","summary":True}),(1,query,{"role":"user"})]:
        if text is None:continue
        msg="msg_"+sid+str(n)
        c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",(msg,sid,NOW+n,NOW+n,json.dumps(meta)))
        c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",("prt_"+msg,msg,sid,NOW+n,NOW+n,json.dumps({"type":"text","text":text})))


def check(name,ok,evidence=None):
    r={"name":name,"pass":bool(ok),"evidence":evidence}
    RESULTS.append(r)
    print(json.dumps(r,ensure_ascii=False),flush=True)


SUMMARY="- Quetzal proxy listens on port 8010 and serves four models for this project.\n- Daily database backup artifacts are kept in a separate recovery directory."
db,c=case("basic-memory")
session(c,summary=SUMMARY,query="Quetzal proxy")
session(c,"ses_other","other",query="Quetzal proxy")
c.commit()
rc,out=cli(db,"memory","capture","ses_a")
n=c.execute("SELECT count(*) FROM memory_item").fetchone()[0]
check("Memory capture creates source/items/evidence",rc==0 and n==2 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,{"rc":rc,"items":n})
rc,out=cli(db,"memory","recall","ses_a")
check("Memory recall works in owner project",rc==0 and "8010" in out,out)
check("Recall does not duplicate claim via whole fact",out.count("Quetzal proxy listens")==1,out)
rc,out=cli(db,"memory","recall","ses_other")
check("Memory remains isolated across projects",rc==0 and "Quetzal" not in out,out)
rc,out=cli(db,"memory","capture","ses_a")
check("Recapture is idempotent",rc==0 and c.execute("SELECT count(*) FROM memory_fact").fetchone()[0]==1 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==2 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,out)
path=c.execute("SELECT vault_path FROM memory_fact").fetchone()[0]
check("Published note points to committed memory",path is not None and Path(path).exists(),path)
claim=SUMMARY.split("\n")[0]
chash=hashlib.sha256(("p\n"+claim).encode()).hexdigest()
c.execute("UPDATE memory_item SET status='deleted' WHERE hash=?",(chash,))
c.execute("INSERT INTO memory_tombstone(id,hash,project_id,time_created,time_updated) VALUES('tb',?,'p',?,?)",(chash,NOW,NOW))
c.commit()
rc,out=cli(db,"memory","recall","ses_a")
check("Soft-deleted item suppresses original fact",rc==0 and "8010" not in out,out)
c.execute("DELETE FROM memory_item WHERE hash=?",(chash,))
c.execute("UPDATE part SET data=? WHERE message_id='msg_ses_a0'",(json.dumps({"type":"text","text":SUMMARY+"\n- Operator checks are now performed every morning before service deployment."}),))
c.commit()
rc,capture_output=cli(db,"memory","capture","ses_a")
check("Changed summary still captures allowed claims",rc==0 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]>=2,capture_output)
rc,out=cli(db,"memory","recall","ses_a")
check("Forgotten claim cannot return through changed summary",rc==0 and "8010" not in out,out)
latest=c.execute("SELECT fact,vault_path FROM memory_fact ORDER BY rowid DESC LIMIT 1").fetchone()
check("Recapture redacts forgotten text from new DB fact and note","8010" not in latest[0] and latest[1] is not None and "8010" not in Path(latest[1]).read_text(),latest[0])

db,c=case("real-contradictory-state")
context=" Operators inspect the same dashboard, access logs, health probes and response latency every morning before applying configuration changes to the production service."
old="The production proxy is active."+context
new="The production proxy is inactive."+context
session(c,"ses_on",summary=old)
session(c,"ses_off",summary=new)
c.commit()
rc_on,_=cli(db,"memory","capture","ses_on",real_embed=True)
rc_off,_=cli(db,"memory","capture","ses_off",real_embed=True)
rows=c.execute("SELECT session_id,status FROM memory_item").fetchall()
relations=c.execute("SELECT relation FROM memory_relation").fetchall()
check("Opposite active/inactive claims are not auto-superseded",rc_on==0 and rc_off==0 and len(rows)==2 and all(r[1]=="active" for r in rows) and ("contradicts",) in relations,{"statuses":rows,"relations":relations})
rc,_=cli(db,"memory","prune","--apply")
check("Prune does not discard contradictory active/inactive facts",rc==0 and c.execute("SELECT count(*) FROM memory_fact").fetchone()[0]==2,{"remaining":c.execute("SELECT count(*) FROM memory_fact").fetchone()[0]})

db,c=case("latest-summary")
session(c,summary=SUMMARY)
msg="msg_latest"
c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",(msg,"ses_a",NOW+100,NOW+100,json.dumps({"role":"assistant","summary":True})))
latest="- This latest summary replaces the previous one: the proxy now listens on port 8317.\n- Backup artifacts are verified every morning and copied to the recovery directory."
c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",("prt_latest",msg,"ses_a",NOW+100,NOW+100,json.dumps({"type":"text","text":latest})))
c.commit()
rc,_=cli(db,"memory","capture","ses_a")
fact=c.execute("SELECT fact FROM memory_fact").fetchone()[0]
check("Capture uses current compaction instead of mixing old summaries",rc==0 and "8010" not in fact and "8317" in fact,fact)

db,c=case("many-claims")
session(c,summary="\n".join(f"- Unique claim {i} contains enough descriptive project details for storage." for i in range(20)))
c.commit()
rc,out=cli(db,"memory","capture","ses_a")
check("Capture preserves claims beyond the first twelve",rc==0 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==20 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==20,out)

db,c=case("legacy-tombstone")
session(c,query="Quetzal proxy")
c.execute("INSERT INTO memory_fact(id,session_id,project_id,fact,topic,hash,time_created,time_updated) VALUES('legacy','ses_a','p',?,'Infrastructure',?,?,?)",(SUMMARY,hashlib.sha256(SUMMARY.encode()).hexdigest(),NOW,NOW))
c.execute("INSERT INTO memory_tombstone(id,hash,project_id,time_created,time_updated) VALUES('forgotten',?,'p',?,?)",(chash,NOW,NOW))
c.commit()
rc,out=cli(db,"memory","recall","ses_a")
check("Tombstones suppress legacy claims even without memory_item rows",rc==0 and "8010" not in out,out)

db,c=case("db-rollback")
session(c,summary=SUMMARY)
c.execute("CREATE TRIGGER reject_evidence BEFORE INSERT ON memory_evidence BEGIN SELECT RAISE(ABORT,'forced evidence failure'); END")
c.commit()
rc,out=cli(db,"memory","capture","ses_a")
check("DB failure rolls back fact items source and evidence",rc!=0 and all(c.execute(f"SELECT count(*) FROM {table}").fetchone()[0]==0 for table in ["memory_fact","memory_item","memory_source","memory_evidence"]),{"rc":rc,"output":out})
check("DB failure cannot publish a vault note",not list((ROOT/"vault"/db.stem).rglob("*.md")))
c.execute("DROP TRIGGER reject_evidence")
c.commit()
rc,out=cli(db,"memory","capture","ses_a")
check("Retry after rollback restores complete memory",rc==0 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==2 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,out)

db,c=case("vault-failure")
session(c,summary=SUMMARY)
c.commit()
blocked=ROOT/"blocked-vault"
blocked.write_text("not a directory")
rc,out=cli(db,"memory","capture","ses_a",extra={"OPENCODE_MEMORY_VAULT":str(blocked)})
check("Vault failure retains complete DB memory with no false path",rc==0 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==2 and c.execute("SELECT vault_path FROM memory_fact").fetchone()[0] is None,out)
rc,out=cli(db,"memory","capture","ses_a")
row=c.execute("SELECT vault_path FROM memory_fact").fetchone()
check("Retry repairs DB-only vault publication without duplicate evidence",rc==0 and row[0] is not None and Path(row[0]).exists() and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,out)

db,c=case("concurrent-capture")
session(c,summary=SUMMARY)
c.commit()
captures=[]
threads=[threading.Thread(target=lambda:captures.append(cli(db,"memory","capture","ses_a"))) for _ in range(2)]
for thread in threads:thread.start()
for thread in threads:thread.join()
check("Concurrent captures commit one complete memory",len(captures)==2 and all(r[0]==0 for r in captures) and c.execute("SELECT count(*) FROM memory_fact").fetchone()[0]==1 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==2 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,captures)
stress=[]
for run in range(3):
    workers=[threading.Thread(target=lambda:stress.append(cli(db,"memory","capture","ses_a"))) for _ in range(4)]
    for thread in workers:thread.start()
    for thread in workers:thread.join()
check("Repeated four-writer capture contention is safe",len(stress)==12 and all(r[0]==0 for r in stress) and c.execute("SELECT count(*) FROM memory_fact").fetchone()[0]==1 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0]==2 and c.execute("SELECT count(*) FROM memory_evidence").fetchone()[0]==2,{"attempts":len(stress),"failures":[r for r in stress if r[0]!=0]})

db,c=case("vault-project-isolation")
session(c,"ses_project_p","p",summary=SUMMARY)
session(c,"ses_project_other","other",summary=SUMMARY)
c.commit()
rc_a,_=cli(db,"memory","capture","ses_project_p")
rc_b,_=cli(db,"memory","capture","ses_project_other")
paths=c.execute("SELECT project_id,vault_path FROM memory_fact").fetchall()
check("Vault groups by project identity even with identical directory names",rc_a==0 and rc_b==0 and len(paths)==2 and len({str(Path(r[1]).parent) for r in paths})==2,paths)

db,c=case("archive-reuse")
session(c)
c.execute("UPDATE session SET time_archived=? WHERE id='ses_a'",(NOW,))
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES('ses_a','p','implementer','idle',?,?)",(NOW,NOW))
c.execute("INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('reuse','p','New task','implementer','queued',?,?)",(NOW,NOW))
c.commit()
rc,out=cli(db,"cvis","reuse-check","--session","ses_a","--task","reuse")
check("Archived session is not silently selected for reuse",rc!=0 or json.loads(out)["eligible"] is False,out)
rc,out=cli(db,"cvis","task-claim","reuse","ses_a")
check("Claim requires explicit unarchive",rc!=0,{"rc":rc,"output":out})
check("Rejected archived claim leaves queue and binding intact",c.execute("SELECT status FROM cvis_task WHERE id='reuse'").fetchone()[0]=="queued" and c.execute("SELECT status FROM cvis_session_binding WHERE session_id='ses_a'").fetchone()[0]=="idle")
rc,out=cli(db,"cvis","binding-set","ses_a","implementer","--project","p")
check("Archived session cannot be rebound",rc!=0,out)
c.execute("UPDATE session SET time_archived=NULL WHERE id='ses_a'")
c.commit()
rc,out=cli(db,"cvis","task-claim","reuse","ses_a")
check("Explicit unarchive permits a new claim",rc==0,out)

db,c=case("retired-manager")
session(c,"ses_old_manager")
session(c,"ses_new_manager")
c.execute("UPDATE session SET time_archived=? WHERE id='ses_old_manager'",(NOW,))
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES('ses_old_manager','p','manager','idle',?,?)",(NOW,NOW))
c.commit()
rc,out=cli(db,"cvis","binding-set","ses_new_manager","manager","--project","p")
check("Retired manager can be explicitly replaced",rc==0,{"rc":rc,"output":out})
check("Manager replacement preserves old session and durable history",c.execute("SELECT count(*) FROM session WHERE id='ses_old_manager'").fetchone()[0]==1 and c.execute("SELECT count(*) FROM cvis_session_binding WHERE role='manager'").fetchone()[0]==1 and c.execute("SELECT count(*) FROM cvis_event WHERE type='manager.replaced'").fetchone()[0]==1)

db,c=case("active-manager")
session(c,"ses_old_manager")
session(c,"ses_new_manager")
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated) VALUES('ses_old_manager','p','manager','idle',?,?)",(NOW,NOW))
c.commit()
rc,out=cli(db,"cvis","binding-set","ses_new_manager","manager","--project","p")
check("Live manager cannot be silently replaced",rc!=0,out)
c.execute("UPDATE session SET time_archived=? WHERE id='ses_old_manager'",(NOW,))
c.execute("INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('manager_task','p','Outstanding work','manager','running',?,?)",(NOW,NOW))
c.execute("INSERT INTO cvis_task_run(id,task_id,session_id,attempt,status,time_created,time_updated) VALUES('manager_run','manager_task','ses_old_manager',1,'running',?,?)",(NOW,NOW))
c.commit()
rc,out=cli(db,"cvis","binding-set","ses_new_manager","manager","--project","p")
check("Archived manager with unresolved work requires recovery first",rc!=0,out)

db,c=case("capture-crash")
session(c,summary=SUMMARY)
c.commit()
STALLED=threading.Event()
RELEASE=threading.Event()
class EmbedDelay(http.server.BaseHTTPRequestHandler):
    count=0
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length","0")))
        EmbedDelay.count+=1
        if EmbedDelay.count>=2:
            STALLED.set()
            RELEASE.wait(20)
        try:
            payload=b'{"embeddings":[[1,0]]}'
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(("127.0.0.1",0),EmbedDelay)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(ENV,OPENCODE_DB=str(db),OPENCODE_MEMORY_VAULT=str(ROOT/"crash-vault"),OPENCODE_MEMORY_EMBED_URL=f"http://127.0.0.1:{server.server_port}")
proc=subprocess.Popen([BIN,"memory","capture","ses_a","--pure"],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
ready=STALLED.wait(20)
if proc.poll() is None:proc.kill()
proc.wait(timeout=10)
RELEASE.set()
server.shutdown()
notes=list((ROOT/"crash-vault").rglob("*.md"))
check("Crash cannot publish a memory note before DB commit",ready and not notes,{"stalled_in_embedding":ready,"db_facts":c.execute("SELECT count(*) FROM memory_fact").fetchone()[0],"orphan_notes":[str(p.relative_to(ROOT)) for p in notes]})

report={"pass":sum(r["pass"] for r in RESULTS),"fail":sum(not r["pass"] for r in RESULTS),"total":len(RESULTS),"results":RESULTS}
(ROOT/"results.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print("REPORT_ROOT",ROOT)
print("RESULT",json.dumps({k:report[k] for k in ["pass","fail","total"]}))
sys.exit(1 if report["fail"] else 0)
