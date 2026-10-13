import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-doctor-", dir="/tmp"))
NOW = int(time.time() * 1000)
RESULTS = []
ENV = dict(os.environ, HOME=str(ROOT / "home"))


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


def doctor(db, slug):
    rc, out = cli(db, "cvis", "managed-doctor", "--slug", slug)
    return rc, json.loads(out) if rc == 0 else out


template = ROOT / "template.db"
rc, out = cli(template, "db", "SELECT count(*) FROM migration")
if rc:
    raise RuntimeError(out)

db = ROOT / "doctor.db"
with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
    src.backup(dst)
c = sqlite3.connect(db)
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("doc-native", str(ROOT), "[]", NOW, NOW))
c.execute("INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?,?)", ("ses_mgr", "doc-native", "ses_mgr", str(ROOT), "Manager", "v1", NOW, NOW))
c.execute("INSERT INTO cvis_session_binding(session_id,project_id,role,status,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?)", ("ses_mgr", "doc-native", "manager", "idle", NOW, NOW))
c.commit()

rc, mid = cli(db, "cvis", "managed-register", "doc", "--type", "work")
check("doctor fixture registers", rc == 0 and mid.startswith("mp_"), mid)
rc, out = doctor(db, "doc")
check("unlinked native is reported", rc == 0 and out["issues"] == ["native-unlinked"], out)

rc, _ = cli(db, "cvis", "managed-link", mid, "doc-native")
rc, out = doctor(db, "doc")
check("linked project without goals reports no-active-goal only",
      rc == 0 and out["issues"] == ["no-active-goal"] and out["bindings"]["manager"] is True, out)

c.execute("INSERT INTO cvis_project_goal(id,project_id,title,objective,status,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?)", ("goal_doc", "doc-native", "Doc goal", "Prove admission", "active", NOW, NOW))
c.execute("INSERT INTO memory_fact(id,project_id,fact,topic,hash,time_created,time_updated)"
          " VALUES(?,?,?,?,?,?,?)", ("mem_doc", "doc-native", "The pilot API must return answer 42.", "infra", "h1", NOW, NOW))
c.commit()
rc, gid = cli(db, "cvis", "schedule-register", mid, "hourly", "--interval", "3600")
rc, out = doctor(db, "doc")
check("healthy project reports no issues with counts",
      rc == 0 and out["issues"] == [] and out["goals"] == {"total": 1, "active": 1}
      and out["memory"] == {"facts": 1, "items": 0} and out["schedules"] == {"total": 1, "failing": 0}, out)

with sqlite3.connect(db) as con:
    con.execute("UPDATE cvis_schedule SET consecutive_failures=3, lease_expires=? WHERE id=?", (NOW - 1, gid))
    con.commit()
rc, out = doctor(db, "doc")
check("failing and stale-leased schedules are reported",
      rc == 0 and sorted(out["issues"]) == ["schedule-failing", "schedule-lease-stale"], out)

with sqlite3.connect(db) as con:
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("DELETE FROM project WHERE id='doc-native'")
    con.commit()
rc, out = doctor(db, "doc")
check("missing native row is reported without crashing",
      rc == 0 and "native-missing" in out["issues"] and out["memory"] == {"facts": 0, "items": 0}, out)

counts = {"pass": sum(r["pass"] for r in RESULTS), "fail": sum(not r["pass"] for r in RESULTS), "total": len(RESULTS)}
(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps(counts))
if counts["fail"]:
    raise SystemExit(1)
