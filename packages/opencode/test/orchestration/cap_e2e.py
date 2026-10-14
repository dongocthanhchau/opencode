import json
import os
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-cap-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB))
NOW = 1791953000000
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
db("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_sw','sp','w',?, 'w','v1', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('tw','sp','w','implementer','running', ?, ?)", (NOW, NOW))
db("INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_sw','sp','implementer','tw','busy', ?, ?)", (NOW, NOW))

r = cli("cvis", "cap-propose", "--project", "sp", "--kind", "mcp", "--name", "fetch",
        "--description", "A fetch MCP server for retrieving web content in tasks.",
        "--session", "ses_sw")
check("propose", r.returncode == 0 and "version" in shown(r), shown(r)[:150])
cap_id = json.loads(r.stderr.strip().splitlines()[-1] if r.stderr.strip() else r.stdout.strip().splitlines()[-1])["id"]

r = cli("cvis", "cap-status", cap_id, "active", "--session", "ses_sm")
check("skip-guarded", r.returncode != 0, shown(r)[-160:])
r = cli("cvis", "cap-status", cap_id, "canary", "--session", "ses_sm")
check("canary", r.returncode == 0, shown(r)[:120])
r = cli("cvis", "cap-status", cap_id, "active", "--session", "ses_sm")
check("approve", r.returncode == 0, shown(r)[:120])
r = cli("cvis", "cap-list", "--project", "sp", "--status", "active")
check("list-active", r.returncode == 0 and "fetch" in shown(r), shown(r)[:200])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
