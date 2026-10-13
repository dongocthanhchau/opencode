import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-goal-pin-", dir="/tmp"))
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

db = ROOT / "pin.db"
with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
    src.backup(dst)
c = sqlite3.connect(db)
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("p", str(ROOT / "p"), "[]", NOW, NOW))
c.execute("INSERT INTO cvis_project_goal(id,project_id,title,objective,status,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?)",
          ("goal_pin", "p", "Pilot answer delivery",
           "The pilot API must return answer 42 for every request.", "active", NOW, NOW))
c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?,?)", ("ses_a", "p", "ses_a", str(ROOT), "Pin audit", "v1", NOW, NOW))
summary = "\n".join([
    "- Objective: ship the pilot API release.",
    "- Review checklist verified for staging status gateway.",
    "- Second review checklist confirms staging status dashboard.",
    "- Staging status review checklist signed by operators.",
    "- Review of checklist covers staging status monitors.",
    "- Final review checklist tracks staging status alerts.",
])
c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
          ("msg_sum", "ses_a", NOW + 1, NOW + 1, json.dumps({"role": "assistant", "summary": True})))
c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
          ("prt_sum", "msg_sum", "ses_a", NOW + 1, NOW + 1, json.dumps({"type": "text", "text": summary})))
c.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
          ("msg_q", "ses_a", NOW + 100, NOW + 100, json.dumps({"role": "user"})))
c.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
          ("prt_q", "msg_q", "ses_a", NOW + 100, NOW + 100,
           json.dumps({"type": "text", "text": "review checklist staging status"})))
c.commit()

rc, out = cli(db, "memory", "capture", "ses_a")
check("six claims captured past the five-line cap", rc == 0 and c.execute("SELECT count(*) FROM memory_item").fetchone()[0] == 6, out)

rc, out = cli(db, "memory", "recall", "ses_a")
lines = [line for line in out.splitlines() if line.startswith("- [")]
check("lowest-ranked goal claim keeps a pinned slot", rc == 0 and any("ship the pilot API" in line for line in lines), out)
check("five-line output bound still respected", len(lines) == 5, {"lines": len(lines)})

c.execute("UPDATE cvis_project_goal SET status='paused' WHERE id='goal_pin'")
c.commit()
rc, out = cli(db, "memory", "recall", "ses_a")
check("paused goal releases the pin and drops out of ranking", rc == 0 and "ship the pilot API" not in out, out)

(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps({"pass": sum(r["pass"] for r in RESULTS),
                            "fail": sum(not r["pass"] for r in RESULTS), "root": str(ROOT)}), flush=True)
