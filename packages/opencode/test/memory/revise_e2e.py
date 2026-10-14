import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-revise-smoke-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB), OPENCODE_MEMORY_VAULT=str(ROOT / "vault"),
           OPENCODE_MEMORY_EMBED_URL="http://127.0.0.1:9")
NOW = 1791952000000
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
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(sql, params).fetchall()
        con.commit()
        return rows
    finally:
        con.close()


r = cli("memory", "job-list")
check("db-init", r.returncode == 0, shown(r)[:80])
db("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('rp',?, '[]', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_rv','rp','rv',?, 'rv','v1', ?, ?)", (str(ROOT), NOW, NOW))
db("INSERT INTO memory_item(id,project_id,kind,scope,status,claim,topic,hash,session_id,time_created,time_updated) VALUES('it_rv','rp','fact','project','active','The smoke quasar array needs hourly drift logging for audits.','t','h1','ses_rv', ?, ?)", (NOW, NOW))

r = cli("memory", "revise", "it_rv", "--session", "ses_rv", "--text", "The smoke quasar array needs daily drift logging with timestamps.")
check("revise-ok", r.returncode == 0 and "deduped" in shown(r), shown(r)[:200])
st = db("SELECT status FROM memory_item WHERE id='it_rv'")[0][0]
arch = db("SELECT COUNT(*) FROM memory_archive")[0][0]
tomb = db("SELECT COUNT(*) FROM memory_tombstone")[0][0]
check("old-retired", st == "superseded" and arch == 1 and tomb == 1, [st, arch, tomb])

r = cli("memory", "rewrite", "--project", "rp", "--session", "ses_rv")
check("rewrite-ok", r.returncode == 0 and "merged" in shown(r), shown(r)[:200])

r = cli("memory", "revise", "it_rv", "--session", "ses_rv", "--text", "short")
check("revise-short-denied", r.returncode != 0, shown(r)[-200:])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
