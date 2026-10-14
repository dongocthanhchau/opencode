import json
import os
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-lib-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB))
NOW = 1791957000000
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
(ROOT / "plib").mkdir(exist_ok=True)
(ROOT / "plib" / "greet.json").write_text(json.dumps({"name": "libgreet", "body": "Greet {{who}} warmly."}))
(ROOT / "plib" / "bad.json").write_text("nope")

r = cli("cvis", "template-import-lib", "--project", "sp", "--dir", "plib", "--session", "ses_sm")
check("import", r.returncode == 0 and "libgreet" in shown(r), shown(r)[:250])
r = cli("cvis", "template-render", "libgreet", "--var", "who=world")
check("canary-not-served-by-default", r.returncode != 0 and "libgreet@stable" in shown(r), shown(r)[:200])
r = cli("cvis", "template-status", "libgreet", "1", "stable", "--session", "ses_sm")
check("promote", r.returncode == 0, shown(r)[:150])
r = cli("cvis", "template-render", "libgreet", "--var", "who=world")
check("render-after-promote", r.returncode == 0 and "Greet world" in shown(r), shown(r)[:200])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
