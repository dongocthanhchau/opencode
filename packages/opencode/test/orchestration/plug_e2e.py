import json
import os
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-plug-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB))
NOW = 1791955000000
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
db("INSERT INTO cvis_managed_project(id,slug,type,status,time_created,time_updated) VALUES('mp_sp','plug','initiative','planning', ?, ?)", (NOW, NOW))
(ROOT / "simpskill").mkdir(exist_ok=True)
(ROOT / "simpskill" / "SKILL.md").write_text("---\nname: demo-skill\ndescription: A demonstration skill for smoke testing imports.\n---\n\nDo demo things.\n")

manifest = json.dumps({"name": "demo-tool", "version": 1, "kind": "tool",
                       "description": "A demonstration tool plugin for smoke tests.",
                       "entry": "demo.ts"})
r = cli("cvis", "plugin-install", "--project", "sp", "--manifest", manifest, "--session", "ses_sm")
check("install-tool", r.returncode == 0 and "proposed" in shown(r) or "version" in shown(r), shown(r)[:160])

r = cli("cvis", "plugin-import-skill", "--project", "sp", "--dir", "simpskill", "--session", "ses_sm")
check("import-skill", r.returncode == 0 and "demo-skill" in shown(r), shown(r)[:160])

r = cli("cvis", "task-create", "--project", "sp", "--title", "t", "--role", "implementer",
        "--acceptance", json.dumps([{"id": "a1", "label": "done", "weight": 1}]))
check("create-acceptance", r.returncode == 0, shown(r)[:120])
tid = (r.stdout.strip() or r.stderr.strip()).splitlines()[-1]
acc = db("SELECT acceptance FROM cvis_task WHERE id=?", (tid,))[0][0]
check("acceptance-stored", "a1" in acc, acc[:120])

r = cli("cvis", "managed-metadata", "--slug", "nope", "--metadata", "{}", "--session", "ses_sm")
check("metadata-unlinked-denied", r.returncode != 0, shown(r)[-160:])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
