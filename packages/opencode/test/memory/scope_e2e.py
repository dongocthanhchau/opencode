import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-scope-e2e-", dir="/tmp"))
DB = ROOT / "state.db"
ENV = dict(os.environ, OPENCODE_DB=str(DB), OPENCODE_MEMORY_VAULT=str(ROOT / "vault"),
           OPENCODE_MEMORY_EMBED_URL="http://127.0.0.1:9")
NOW = 1791946600000
RESULTS = []


def check(name, ok, evidence=None):
    RESULTS.append({"name": name, "pass": bool(ok), "evidence": evidence})
    print(json.dumps({"name": name, "pass": bool(ok), "evidence": evidence}), flush=True)
    if not ok:
        raise AssertionError(name)


def cli(*args):
    return subprocess.run([BIN, *args], capture_output=True, text=True, timeout=120, env=ENV)


def shown(r):
    return (r.stdout + r.stderr).lower()


def db(sql, params=()):
    con = sqlite3.connect(DB)
    try:
        cur = con.execute(sql, params)
        rows = cur.fetchall()
        con.commit()
        return rows
    finally:
        con.close()


def seed_session(sid, pid):
    db("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?, ?, ?) ON CONFLICT(id) DO NOTHING",
       (pid, str(ROOT), "[]", NOW, NOW))
    db("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
       (sid, pid, sid, str(ROOT), sid, "v1", NOW, NOW))


def seed_summary(sid, text):
    db("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?, ?, ?)",
       ("msg_" + sid, sid, NOW, NOW, '{"role":"assistant","summary":true}'))
    db("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
       ("prt_" + sid, "msg_" + sid, sid, NOW, NOW, json.dumps(json.dumps({"type": "text", "text": text}))))


def seed_query(sid, text):
    db("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?, ?, ?)",
       ("q_" + sid, sid, NOW + 1, NOW + 1, '{"role":"user"}'))
    db("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
       ("qp_" + sid, "q_" + sid, sid, NOW + 1, NOW + 1, json.dumps(json.dumps({"type": "text", "text": text}))))


init = cli("memory", "job-list")
check("db-init", init.returncode == 0, init.stderr[-200:])
seed_session("ses_a", "tp")
seed_session("ses_b", "tp")
seed_session("ses_q", "tq")
seed_summary("ses_a", "- The quasar xylophone array requires zephyr calibration every cycle for stable harmonics.\n"
                    "- Operators must log every zephyr drift event with a timestamp for later auditing purposes.")
seed_query("ses_a", "What is the quasar calibration status?")
seed_query("ses_b", "What is the quasar calibration status?")
seed_query("ses_q", "What is the quasar calibration status?")

r = cli("memory", "capture", "ses_a")
check("capture-ok", r.returncode == 0, r.stderr[-300:])
scope = db("SELECT scope, session_id, project_id FROM memory_item WHERE session_id='ses_a'")
check("capture-session-tier", len(scope) > 0 and all(s[0] == "session" and s[1] == "ses_a" and s[2] == "tp" for s in scope), scope)

r = cli("memory", "recall", "ses_a")
check("recall-own-session", r.returncode == 0 and "quasar" in shown(r), {"rc": r.returncode, "out": shown(r)[:300]})
r = cli("memory", "recall", "ses_b")
check("recall-sibling-denied", r.returncode == 0 and "quasar" not in shown(r), shown(r)[:300])

item = db("SELECT id FROM memory_item WHERE session_id='ses_a' LIMIT 1")[0][0]
r = cli("memory", "set-scope", item, "project", "--session", "ses_b")
check("promote-ok", r.returncode == 0 and "project" in shown(r), {"rc": r.returncode, "out": shown(r)[:200]})
r = cli("memory", "recall", "ses_b")
check("recall-after-promote", r.returncode == 0 and "quasar" in shown(r), shown(r)[:300])

r = cli("memory", "remember", "--scope", "user", "--text",
        "The operator prefers nebula piston dashboards with waffle charts for every single review session.")
check("remember-user-ok", r.returncode == 0 and "deduped" in shown(r), shown(r)[:200])
db("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('q_ses_q2','ses_q',?, ?, '{\"role\":\"user\"}')", (NOW + 2, NOW + 2))
db("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('qp_ses_q2','q_ses_q2','ses_q',?, ?, ?)",
   (NOW + 2, NOW + 2, json.dumps(json.dumps({"type": "text", "text": "Show me the nebula dashboard preferences."}))))
r = cli("memory", "recall", "ses_q")
check("recall-user-cross-project", r.returncode == 0 and "nebula" in shown(r), shown(r)[:300])

r = cli("memory", "remember", "--scope", "system", "--text",
        "The cobalt falcon harbor channel is the fallback paging route for all production incidents.")
check("remember-system-ok", r.returncode == 0, r.stdout[:200] + r.stderr[-200:])
db("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('q_ses_a2','ses_a',?, ?, '{\"role\":\"user\"}')", (NOW + 3, NOW + 3))
db("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('qp_ses_a2','q_ses_a2','ses_a',?, ?, ?)",
   (NOW + 3, NOW + 3, json.dumps(json.dumps({"type": "text", "text": "What is the cobalt fallback paging route?"}))))
r = cli("memory", "recall", "ses_a")
check("recall-system-global", r.returncode == 0 and "cobalt" in shown(r), shown(r)[:300])

r = cli("memory", "set-scope", item, "project", "--session", "ses_q")
check("set-scope-cross-project-denied", r.returncode != 0 and "scope error" in (r.stdout + r.stderr).lower(),
      (r.stdout + r.stderr)[-300:])
r = cli("memory", "remember", "--scope", "user", "--text", "too short")
check("remember-short-denied", r.returncode != 0, (r.stdout + r.stderr)[-200:])

db("INSERT INTO memory_item(id,project_id,kind,status,claim,topic,hash,time_created,time_updated) VALUES(?,?,?,?,?,?,?, ?, ?)",
   ("mit_legacy", "tp", "fact", "active", "The legacy harbor cranes need quarterly grease service visits.", "legacy", "legacylegacy123", NOW, NOW))
db("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('q_ses_b2','ses_b',?, ?, '{\"role\":\"user\"}')", (NOW + 4, NOW + 4))
db("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('qp_ses_b2','q_ses_b2','ses_b',?, ?, ?)",
   (NOW + 4, NOW + 4, json.dumps(json.dumps({"type": "text", "text": "When do the legacy harbor cranes need service?"}))))
r = cli("memory", "recall", "ses_b")
check("recall-legacy-project-tier", r.returncode == 0 and "harbor" in shown(r), shown(r)[:300])

print(json.dumps({"summary": {"pass": sum(1 for x in RESULTS if x["pass"]), "total": len(RESULTS)}}))
