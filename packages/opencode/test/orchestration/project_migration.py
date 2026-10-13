import base64
import json
import os
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-project-migration-", dir="/tmp"))
HOME = ROOT / "home"
WORK = ROOT / "repo"
HOME.mkdir()
WORK.mkdir()
NOW = int(time.time() * 1000)
RESULTS = []


def check(name, ok, evidence=None):
    row = {"name": name, "pass": bool(ok), "evidence": evidence}
    RESULTS.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
    if not ok:
        raise AssertionError(name)


def run(*args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kwargs)


run("git", "init", "--quiet", str(WORK), check=True)
run("git", "-C", str(WORK), "config", "user.name", "CVIS Test", check=True)
run("git", "-C", str(WORK), "config", "user.email", "cvis-test@example.invalid", check=True)
(WORK / "notes.txt").write_text("managed project fixture\n")
run("git", "-C", str(WORK), "add", "notes.txt", check=True)
run("git", "-C", str(WORK), "commit", "--quiet", "-m", "fixture", check=True)

with __import__("socket").socket() as sock:
    sock.bind(("127.0.0.1", 0))
    PORT = sock.getsockname()[1]
DB = ROOT / "state.db"
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME / ".config"),
           XDG_DATA_HOME=str(HOME / ".local/share"), OPENCODE_DB=str(DB),
           OPENCODE_SERVER_PASSWORD="migration-test")
HEADERS = {"Authorization": "Basic " + base64.b64encode(b"opencode:migration-test").decode(),
           "Content-Type": "application/json", "x-opencode-directory": str(WORK)}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None, timeout=30):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", headers=HEADERS,
                                 method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw.startswith("{") else raw[:500]


def sql(query, params=()):
    with sqlite3.connect(DB) as con:
        return con.execute(query, params).fetchall()


log = (ROOT / "server.log").open("wb")
server = None


def start():
    global server
    server = subprocess.Popen([BIN, "serve", "--port", str(PORT), "--hostname", "127.0.0.1", "--pure"],
                              cwd=WORK, env=ENV, stdout=log, stderr=log)
    for _ in range(60):
        try:
            if api("GET", "/global/health", timeout=2)[0] == 200:
                return
        except OSError:
            pass
        if server.poll() is not None:
            raise RuntimeError("server exited during startup")
        time.sleep(1)
    raise RuntimeError("server did not become healthy")


def stop():
    global server
    if server is not None and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
    server = None


try:
    start()

    code, first = api("POST", "/session", {"title": "migration worker"})
    check("first session creates a real project identity", code == 200 and first["projectID"] != "global",
          {"project": first.get("projectID")})
    old_id = first["projectID"]
    with sqlite3.connect(DB) as con:
        con.execute("INSERT INTO cvis_project_goal(id,project_id,title,objective,status,time_created,time_updated)"
                    " VALUES(?,?,?,?,?,?,?)",
                    ("goal_mig", old_id, "Migration goal", "Survive native ID change", "active", NOW, NOW))
        con.execute("INSERT INTO cvis_task(id,project_id,goal_id,title,role,status,time_created,time_updated)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    ("task_mig", old_id, "goal_mig", "Migration task", "implementer", "queued", NOW, NOW))
        con.execute("INSERT INTO memory_fact(id,project_id,fact,topic,hash,time_created,time_updated)"
                    " VALUES(?,?,?,?,?,?,?)",
                    ("mem_mig", old_id, "The proxy listens on port 8010 for managed work.", "infra",
                     "facthash1", NOW, NOW))
        con.execute("INSERT INTO memory_item(id,project_id,claim,topic,hash,time_created,time_updated)"
                    " VALUES(?,?,?,?,?,?,?)",
                    ("mit_mig", old_id, "The proxy listens on port 8010 for managed work.", "infra",
                     "claimhash1", NOW, NOW))
        con.execute("INSERT INTO memory_tombstone(id,hash,project_id,time_created,time_updated)"
                    " VALUES(?,?,?,?,?)", ("tb_mig", "forgottenhash1", old_id, NOW, NOW))
        con.execute("INSERT INTO memory_archive(id,date,project_id,payload,time_created,time_updated)"
                    " VALUES(?,?,?,?,?,?)",
                    ("arc_mig", "2026-10-14", old_id, json.dumps({"note": "archived"}), NOW, NOW))
        con.commit()

    run("git", "-C", str(WORK), "remote", "add", "origin", "https://example.com/test/repo.git", check=True)
    stop()
    start()
    code, second = api("POST", "/session", {"title": "migration worker after remote change"})
    check("remote change resolves a new native project identity", code == 200 and second["projectID"] not in ("global", old_id),
          {"old": old_id, "new": second.get("projectID")})
    new_id = second["projectID"]

    deadline = time.time() + 30
    projects = []
    while time.time() < deadline:
        projects = sql("SELECT id FROM project")
        if len(projects) == 1 and projects[0][0] == new_id:
            break
        time.sleep(0.5)
    check("old native project row is replaced without duplicates", len(projects) == 1 and projects[0][0] == new_id,
          {"projects": projects})
    check("project goal survives native ID migration",
          sql("SELECT project_id,status FROM cvis_project_goal WHERE id='goal_mig'") == [(new_id, "active")])
    check("project task survives native ID migration",
          sql("SELECT project_id,status FROM cvis_task WHERE id='task_mig'") == [(new_id, "queued")])
    check("memory fact survives native ID migration",
          sql("SELECT project_id FROM memory_fact WHERE id='mem_mig'") == [(new_id,)])
    check("memory item survives native ID migration",
          sql("SELECT project_id FROM memory_item WHERE id='mit_mig'") == [(new_id,)])
    check("memory tombstone and archive follow the new project identity",
          sql("SELECT project_id FROM memory_tombstone WHERE id='tb_mig'") == [(new_id,)] and
          sql("SELECT project_id FROM memory_archive WHERE id='arc_mig'") == [(new_id,)])
    check("migrated session still belongs to the new project",
          sql("SELECT project_id FROM session WHERE id=?", (second["id"],)) == [(new_id,)])
finally:
    stop()
    log.close()
    (ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    print("RESULT", json.dumps({"pass": sum(r["pass"] for r in RESULTS),
                                "fail": sum(not r["pass"] for r in RESULTS), "root": str(ROOT)}), flush=True)
