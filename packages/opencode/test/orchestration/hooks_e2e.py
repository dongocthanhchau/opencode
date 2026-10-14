import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-hooks-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB))
NOW = 1791956000000
RESULTS = []


def check(name, ok, evidence=None):
    RESULTS.append({"name": name, "pass": bool(ok), "evidence": evidence})
    print(json.dumps({"name": name, "pass": bool(ok), "evidence": evidence}), flush=True)
    if not ok:
        raise AssertionError(name)


def cli(*args):
    return subprocess.run([BIN, *args], capture_output=True, text=True, timeout=120, env=ENV)


def shown(r):
    return r.stdout + r.stderr


def db(sql, params=()):
    import sqlite3
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(sql, params).fetchall()
        con.commit()
        return rows
    finally:
        con.close()


r = cli("cvis", "cap-list", "--project", "sp")
check("db-init", True, shown(r)[:60])
db("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('sp',?, '[]', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_sm','sp','m',?, 'm','v1', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('tm','sp','m','manager','running', ?, ?)", (NOW, NOW))
db("INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_sm','sp','manager','tm','busy', ?, ?)", (NOW, NOW))
db("INSERT INTO cvis_task(id,project_id,title,role,status,scope,time_created,time_updated) VALUES('tw','sp','w','implementer','running','{}', ?, ?)", (NOW, NOW))
old = NOW - 3 * 3600 * 1000
db("INSERT INTO cvis_event(id,project_id,entity_kind,entity_id,type,sequence,payload,time_created,time_updated) VALUES('ev1','sp','task','tw','task.claimed',1,'{}', ?, ?)", (old, old))

r = cli("cvis", "harness-analyze", "--project", "sp", "--session", "ses_sm")
check("analyze", r.returncode == 0 and "stalled" in shown(r), shown(r)[:250])
finding = [e for e in json.loads(shown(r).strip().splitlines()[-1]) if e["entityID"] == "tw"][0]
r = cli("cvis", "harness-apply", finding["eventID"], "--session", "ses_sm")
check("apply-pause", r.returncode == 0 and "pause-stalled" in shown(r), shown(r)[:200])
st = db("SELECT status FROM cvis_task WHERE id='tw'")[0][0]
check("task-paused", st == "paused", st)
r = cli("cvis", "harness-apply", finding["eventID"], "--session", "ses_sm")
check("double-apply-denied", r.returncode != 0 and "decided" in shown(r), shown(r)[-160:])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
