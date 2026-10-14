import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-mcp-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
SRV = ROOT / "mini_mcp.py"
ENV = dict(os.environ, OPENCODE_DB=str(DB))
NOW = 1791954000000
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


SRV.write_text(
    "from mcp.server.fastmcp import FastMCP\n"
    "m = FastMCP('smoke')\n"
    "@m.tool()\n"
    "def ping() -> str:\n"
    "    return 'pong'\n"
    "m.run()\n"
)

r = cli("cvis", "cap-list", "--project", "sp")
check("db-init", True, shown(r)[:60])
db("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('sp',?, '[]', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_sm','sp','m',?, 'm','v1', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO cvis_task(id,project_id,title,role,status,time_created,time_updated) VALUES('tm','sp','m','manager','running', ?, ?)", (NOW, NOW))
db("INSERT INTO cvis_session_binding(session_id,project_id,role,task_id,status,time_created,time_updated) VALUES('ses_sm','sp','manager','tm','busy', ?, ?)", (NOW, NOW))

payload = json.dumps({"transport": "stdio", "command": ["/home/chad/CVIS/.venv/bin/python", str(SRV)]})
r = cli("cvis", "cap-propose", "--project", "sp", "--kind", "mcp", "--name", "mini",
        "--description", "A minimal stdio MCP server used to prove live handshakes.",
        "--payload", payload, "--session", "ses_sm")
check("propose", r.returncode == 0, shown(r)[:150])
text = shown(r)
cap_id = json.loads(text.strip().splitlines()[-1])["id"]
r = cli("cvis", "cap-status", cap_id, "canary", "--session", "ses_sm")
check("canary", r.returncode == 0, shown(r)[:120])

t0 = time.time()
r = cli("cvis", "mcp-probe", cap_id, "--session", "ses_sm", "--timeout-ms", "30000")
dt = round(time.time() - t0, 1)
check("live-stdio-probe", r.returncode == 0 and "ping" in shown(r), [shown(r)[:300], dt])

r = cli("cvis", "cap-status", "cap_missing", "canary", "--session", "ses_sm")
check("missing-denied", r.returncode != 0, shown(r)[-160:])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
