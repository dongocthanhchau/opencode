import base64
import json
import os
import shlex
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-compact-job-", dir="/tmp"))
HOME = ROOT / "home"
WORK = ROOT / "work"
HOME.mkdir()
WORK.mkdir()
RESULTS = []


def check(name, ok, evidence=None):
    RESULTS.append({"name": name, "pass": bool(ok), "evidence": evidence})
    print(json.dumps({"name": name, "pass": bool(ok), "evidence": evidence}), flush=True)
    if not ok:
        raise AssertionError(name)


def run(*args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kwargs)


run("git", "init", "--quiet", str(WORK), check=True)
run("git", "-C", str(WORK), "config", "user.name", "CVIS Test", check=True)
run("git", "-C", str(WORK), "config", "user.email", "cvis-test@example.invalid", check=True)
(WORK / "notes.txt").write_text("The pilot API must return answer 42. Staging reviews live under /srv/pilot/review.\n")
run("git", "-C", str(WORK), "add", "notes.txt", check=True)
run("git", "-C", str(WORK), "commit", "--quiet", "-m", "fixture", check=True)

source = json.loads(Path("/home/chad/.config/opencode/opencode.json").read_text())
cfg = {"model": "cline/cline-free/mimo-v2.6-flash", "small_model": "cline/cline-free/mimo-v2.6-flash",
       "provider": {"cline": source["provider"]["cline"]}, "plugin": [], "mcp": {}}
cfgdir = HOME / ".config" / "opencode"
cfgdir.mkdir(parents=True)
(cfgdir / "opencode.json").write_text(json.dumps(cfg))
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    PORT = sock.getsockname()[1]
DB = ROOT / "state.db"
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME / ".config"),
           XDG_DATA_HOME=str(HOME / ".local/share"), OPENCODE_DB=str(DB),
           OPENCODE_SERVER_PASSWORD="compact-job-test", OPENCODE_MEMORY_VAULT=str(ROOT / "vault"))
for line in Path("/etc/systemd/system/oc-opencode.service").read_text().splitlines():
    if line.startswith("Environment="):
        for item in shlex.split(line[len("Environment="):]):
            key, sep, value = item.partition("=")
            if sep and key.startswith("CVIS_"):
                ENV.setdefault(key, value)
HEADERS = {"Authorization": "Basic " + base64.b64encode(b"opencode:compact-job-test").decode(),
           "Content-Type": "application/json", "x-opencode-directory": str(WORK)}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None, timeout=240):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", headers=HEADERS, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    with OPENER.open(req, timeout=timeout) as response:
        raw = response.read().decode()
        return response.status, json.loads(raw) if raw else None


def sql(query, params=()):
    with sqlite3.connect(DB) as con:
        return con.execute(query, params).fetchall()


log = (ROOT / "server.log").open("wb")
server = subprocess.Popen([BIN, "serve", "--port", str(PORT), "--hostname", "127.0.0.1", "--pure"],
                          cwd=WORK, env=ENV, stdout=log, stderr=log)
try:
    for _ in range(60):
        try:
            if api("GET", "/global/health", timeout=2)[0] == 200:
                break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError("server did not become healthy")
    _, session = api("POST", "/session", {"title": "compact job session"})
    sid = session["id"]
    for i, text in enumerate([
        "The pilot API must return answer 42 for every request. Remember this goal.",
        "Staging reviews live under /srv/pilot/review and must stay readable.",
        "Release requires independent artifact review before Done.",
    ]):
        code, _ = api("POST", f"/session/{sid}/message",
                      {"agent": "build", "noReply": True, "parts": [{"type": "text", "text": text}]})
        check(f"history message {i + 1} stored", code == 200)
    code, summary = api("POST", f"/session/{sid}/summarize",
                        {"providerID": "cline", "modelID": "cline-free/mimo-v2.6-flash"}, timeout=300)
    check("real V1 compaction completes", code == 200, True if code == 200 else summary)
    jobs = []
    for _ in range(120):
        jobs = sql("SELECT id,status,attempts FROM memory_job WHERE kind='capture' ORDER BY time_created DESC")
        if jobs and jobs[0][1] in ("done", "failed"):
            break
        time.sleep(1)
    check("compaction produced a durable capture job", len(jobs) > 0, jobs)
    check("capture job finished done with attempts recorded", jobs[0][1] == "done" and jobs[0][2] >= 1, jobs[0])
    facts = sql("SELECT count(*) FROM memory_fact")[0][0]
    items = sql("SELECT count(*) FROM memory_item WHERE status='active'")[0][0]
    check("job-driven capture stored facts and items", facts >= 1 and items >= 1, {"facts": facts, "items": items})
finally:
    if server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
    log.close()
    (ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    print("RESULT", json.dumps({"pass": sum(r["pass"] for r in RESULTS),
                                "fail": sum(not r["pass"] for r in RESULTS), "root": str(ROOT)}), flush=True)
