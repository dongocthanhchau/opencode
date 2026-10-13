import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-multi-compact-", dir="/tmp"))
HOME = ROOT / "home"
HOME.mkdir()
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME / ".config"),
           XDG_DATA_HOME=str(HOME / ".local/share"), OPENCODE_MEMORY_EMBED_URL="http://127.0.0.1:9")
NOW = int(time.time() * 1000)
RESULTS = []


def cli(db, *args):
    env = dict(ENV, OPENCODE_DB=str(db), OPENCODE_MEMORY_VAULT=str(ROOT / "vault" / db.stem))
    p = subprocess.run([BIN, *args, "--pure"], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=180)
    return p.returncode, (p.stdout + p.stderr).strip()


def check(name, ok, evidence=None):
    row = {"name": name, "pass": bool(ok), "evidence": evidence}
    RESULTS.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
    if not ok:
        raise AssertionError(name)


template = ROOT / "template.db"
rc, out = cli(template, "db", "SELECT 1")
if rc:
    raise RuntimeError(out)

db = ROOT / "long.db"
with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
    src.backup(dst)
c = sqlite3.connect(db)
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("p", str(ROOT / "p"), "[]", NOW, NOW))
c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?,?)", ("ses_work", "p", "ses_work", str(ROOT), "Long pilot task", "v1", NOW, NOW))
c.commit()

ROUND1 = ("- Project goal for this long task: the pilot API must return answer 42 for every request.\n"
          "- The pilot source currently returns 41 and must be edited to return 42.")
ROUND2 = ("- Progress update: the worker inspected the pilot source and confirmed it still returns 41.\n"
          "- The staging directory for review artifacts is /srv/pilot/review and must be readable.")
ROUND3 = ("- Final status: implementation finished and the pilot API now returns 42 in local checks.\n"
          "- The release checklist requires independent artifact review before Done.")


def add_summary(n, text):
    msg = f"msg_sum{n}"
    c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
              (msg, "ses_work", NOW + n, NOW + n, json.dumps({"role": "assistant", "summary": True})))
    c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
              ("prt_" + msg, msg, "ses_work", NOW + n, NOW + n, json.dumps({"type": "text", "text": text})))
    c.commit()


add_summary(1, ROUND1)
rc, out = cli(db, "memory", "capture", "ses_work")
check("round 1 compaction captures goal and initial facts", rc == 0, out)
r1_items = c.execute("SELECT claim FROM memory_item").fetchall()

add_summary(2, ROUND2)
rc, out = cli(db, "memory", "capture", "ses_work")
check("round 2 compaction captures progress without losing round 1", rc == 0, out)

add_summary(3, ROUND3)
rc, out = cli(db, "memory", "capture", "ses_work")
check("round 3 compaction captures final status", rc == 0, out)
check("three compactions keep three distinct facts",
      c.execute("SELECT count(*) FROM memory_fact").fetchone()[0] == 3)

c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
          ("msg_q", "ses_work", NOW + 100, NOW + 100, json.dumps({"role": "user"})))
c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
          ("prt_q", "msg_q", "ses_work", NOW + 100, NOW + 100,
           json.dumps({"type": "text", "text": "pilot API answer review checklist"})))
c.commit()
rc, out = cli(db, "memory", "recall", "ses_work")
check("recall after three compactions keeps the project goal", rc == 0 and "answer 42" in out, out)
check("recall keeps round 1 source fact", "returns 41" in out, out)
check("recall keeps round 2 staging fact", "/srv/pilot/review" in out, out)
check("recall keeps round 3 release fact", "independent artifact review" in out, out)

goal_claim = "- Project goal for this long task: the pilot API must return answer 42 for every request."
ghash = hashlib.sha256(("p\n" + goal_claim).encode()).hexdigest()
c.execute("UPDATE memory_item SET status='deleted' WHERE hash=?", (ghash,))
c.execute("INSERT INTO memory_tombstone(id,hash,project_id,time_created,time_updated)"
          " VALUES('tb_goal',?, 'p',?,?)", (ghash, NOW, NOW))
c.commit()
rc, out = cli(db, "memory", "recall", "ses_work")
check("forgotten goal stays forgotten while other facts recall", rc == 0 and "answer 42" not in out and "/srv/pilot/review" in out, out)

(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps({"pass": sum(r["pass"] for r in RESULTS),
                            "fail": sum(not r["pass"] for r in RESULTS), "root": str(ROOT)}), flush=True)
