import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-xproj-", dir="/tmp"))
HOME = ROOT / "home"
HOME.mkdir()
A = ROOT / "a"
B = A / "sub"
B.mkdir(parents=True)
NOW = int(time.time() * 1000)
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME / ".config"),
           XDG_DATA_HOME=str(HOME / ".local/share"))
RESULTS = []


def cli(db, *args):
    env = dict(ENV, OPENCODE_DB=str(db))
    proc = subprocess.run([BIN, *args, "--pure"], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=90)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def check(name, ok, evidence=None):
    row = {"name": name, "pass": bool(ok), "evidence": evidence}
    RESULTS.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
    if not ok:
        raise AssertionError(name)


template = ROOT / "template.db"
rc, out = cli(template, "db", "SELECT count(*) FROM migration")
if rc:
    raise RuntimeError(out)

db = ROOT / "xproj.db"
with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
    src.backup(dst)
c = sqlite3.connect(db)
c.execute("PRAGMA foreign_keys=ON")
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("proj-a", str(A), "[]", NOW, NOW))
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("proj-b", str(B), "[]", NOW, NOW))
for sid, pid, directory in [("ses_a", "proj-a", str(A)), ("ses_b", "proj-b", str(B))]:
    c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
              (sid, pid, sid, directory, sid, "v1", NOW, NOW))
# TA runs in proj-a writing A/sub/nested; TB is queued in nested proj-b
# writing B/nested -> the same real directory. Raw relative strings
# ("sub/nested" vs "nested") do NOT overlap textually.
c.execute("INSERT INTO cvis_task(id,project_id,title,role,status,scope,assigned_session,active_run_id,attempt,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          ("task_a", "proj-a", "holder", "implementer", "running",
           json.dumps({"write_paths": ["sub/nested"]}), "ses_a", "run_a", 1, NOW, NOW))
c.execute("INSERT INTO cvis_task_run(id,task_id,session_id,attempt,revision,status,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
          ("run_a", "task_a", "ses_a", 1, 1, "running", NOW, NOW))
c.execute("INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
          ("task_b", "proj-b", "nested writer", "implementer", "queued", json.dumps({"write_paths": ["nested"]}), NOW, NOW))
c.execute("INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
          ("task_c", "proj-b", "elsewhere writer", "implementer", "queued", json.dumps({"write_paths": ["sibling"]}), NOW, NOW))
c.commit()

rc, out = cli(db, "cvis", "task-claim", "task_b", "ses_b")
check("cross-project canonical overlap blocks the claim", rc != 0 and "overlaps running task task_a in project proj-a" in out,
      {"rc": rc, "output": out})
check("blocked claim leaves the task queued",
      c.execute("SELECT status FROM cvis_task WHERE id='task_b'").fetchone()[0] == "queued")
rc, out = cli(db, "cvis", "task-claim", "task_c", "ses_b")
check("non-overlapping sibling scope still claims", rc == 0, {"rc": rc, "output": out})

counts = {"pass": sum(r["pass"] for r in RESULTS), "fail": sum(not r["pass"] for r in RESULTS), "total": len(RESULTS)}
(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps(counts))
if counts["fail"]:
    raise SystemExit(1)
