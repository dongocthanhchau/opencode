import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-managed-cli-", dir="/tmp"))
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


template = ROOT / "template.db"
rc, out = cli(template, "db", "SELECT count(*) FROM migration")
if rc:
    raise RuntimeError(out)

db = ROOT / "managed.db"
with sqlite3.connect(template) as src, sqlite3.connect(db) as dst:
    src.backup(dst)
c = sqlite3.connect(db)
c.execute("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
          ("native-1", str(ROOT), "[]", NOW, NOW))
c.commit()

rc, mid = cli(db, "cvis", "managed-register", "cvis", "--type", "core", "--owner", "CVIS", "--mission", "Coordinate")
check("managed-register creates an identity", rc == 0 and mid.startswith("mp_"), {"rc": rc, "id": mid})
rc, again = cli(db, "cvis", "managed-register", "cvis")
check("managed-register is idempotent on slug", rc == 0 and again == mid, again)
rc, out = cli(db, "cvis", "managed-register", "Bad Slug")
check("managed-register rejects bad slugs", rc != 0, out)
rc, out = cli(db, "cvis", "managed-get", "--slug", "cvis")
row = json.loads(out) if rc == 0 else {}
check("managed-get shows planning row", rc == 0 and row.get("status") == "planning" and row.get("id") == mid, out)
rc, out = cli(db, "cvis", "managed-link", mid, "native-1")
check("managed-link binds the native project", rc == 0, out)
rc, out = cli(db, "cvis", "managed-link", mid, "ghost")
check("managed-link refuses missing natives", rc != 0, out)
rc, other = cli(db, "cvis", "managed-register", "cviscode", "--type", "core")
rc, out = cli(db, "cvis", "managed-link", other, "native-1")
check("managed-link refuses a second identity on one native", rc != 0, out)
rc, out = cli(db, "cvis", "managed-status", mid, "active")
check("managed-status rejects lifecycle jumps", rc != 0, out)
for status in ["ready", "active", "paused", "active", "completed"]:
    rc, out = cli(db, "cvis", "managed-status", mid, status)
    check(f"managed-status reaches {status}", rc == 0, out)
rc, out = cli(db, "cvis", "managed-status", mid, "active")
check("managed-status keeps terminal states closed", rc != 0, out)
rc, out = cli(db, "cvis", "managed-list", "--status", "completed")
check("managed-list filters by status", rc == 0 and any(r["slug"] == "cvis" for r in json.loads(out)), out)

counts = {"pass": sum(r["pass"] for r in RESULTS), "fail": sum(not r["pass"] for r in RESULTS), "total": len(RESULTS)}
(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps(counts))
if counts["fail"]:
    raise SystemExit(1)
