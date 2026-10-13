import base64
import http.server
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/.opencode/bin/opencode-cvis")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-schedule-runner-", dir="/tmp"))
HOME = ROOT / "home"
HOME.mkdir()
NOW = int(time.time() * 1000)
RESULTS = []
MODE = {"healthy": True}
CALLS = []


class Provider(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        CALLS.append(payload.get("model"))
        if not MODE["healthy"]:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"service unavailable"}')
            return
        has_tools = "tools" in payload
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if has_tools:
            body = {"tool": "health_echo", "arguments": {"value": "READY"}}
        else:
            body = {"content": "READY"}
        self.wfile.write(("data: " + json.dumps(body) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *args):
        pass


provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
PROVIDER_URL = f"http://127.0.0.1:{provider.server_port}/v1"


def check(name, ok, evidence=None):
    row = {"name": name, "pass": bool(ok), "evidence": evidence}
    RESULTS.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
    if not ok:
        raise AssertionError(name)


def cli(*args):
    env = dict(os.environ, HOME=str(HOME), OPENCODE_DB=str(ROOT / "state.db"))
    proc = subprocess.run([BIN, *args, "--pure"], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=60)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def sql(query, params=()):
    with sqlite3.connect(ROOT / "state.db") as con:
        return con.execute(query, params).fetchall()


def probe_alias(url):
    """Minimal chat + structured-tool health probe against an OpenAI-style base URL."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    outcomes = {}
    for kind in ["chat", "tools"]:
        payload = {"model": "health-probe", "max_tokens": 64,
                   "messages": [{"role": "user", "content": "Reply exactly READY" if kind == "chat"
                                                 else "Call health_echo with value READY."}]}
        if kind == "tools":
            payload["tools"] = [{"type": "function", "function": {
                "name": "health_echo", "description": "Echo",
                "parameters": {"type": "object", "properties": {"value": {"type": "string"}},
                               "required": ["value"]}}}]
            payload["tool_choice"] = {"type": "function", "function": {"name": "health_echo"}}
        req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=15) as response:
                raw = response.read().decode()
                outcomes[kind] = response.status == 200 and "READY" in raw
        except Exception as error:
            outcomes[kind] = False
            outcomes[kind + "_error"] = type(error).__name__
    roundtrip = bool(outcomes.get("chat")) and bool(outcomes.get("tools"))
    return roundtrip, outcomes


rc, _ = cli("db", "SELECT 1")
if rc:
    raise RuntimeError("fixture database did not initialize")

rc, managed = cli("cvis", "managed-register", "ops", "--type", "core")
check("runner registers its managed owner", rc == 0 and managed.startswith("mp_"), managed)
rc, sch = cli("cvis", "schedule-register", managed, "hourly-health", "--kind", "health",
              "--interval", "3600", "--payload", json.dumps({"probe_url": PROVIDER_URL}))
check("runner registers the hourly health schedule", rc == 0 and sch.startswith("sch_"), sch)

rc, out = cli("cvis", "schedule-tick", "--owner", "runner-1")
claimed = json.loads(out) if rc == 0 else None
check("tick claims the due schedule exactly once", rc == 0 and claimed and claimed["id"] == sch, out)
rc, out = cli("cvis", "schedule-tick", "--owner", "runner-2")
check("second tick finds nothing while leased", rc == 0 and out == "null", out)

roundtrip, evidence = probe_alias(PROVIDER_URL)
rc, out = cli("cvis", "schedule-complete", sch, "--owner", "runner-1",
              "--status", "ok" if roundtrip else "failed")
check("healthy probe completes the run as ok", rc == 0 and roundtrip, evidence)
row = sql("SELECT last_status,consecutive_failures,lease_owner,enabled FROM cvis_schedule WHERE id=?", (sch,))[0]
check("completion releases the lease and records ok", row == ("ok", 0, None, 1), row)

MODE["healthy"] = False
rc, out = cli("cvis", "schedule-tick", "--owner", "runner-1")
check("no due schedule before the next interval", rc == 0 and out == "null", out)
with sqlite3.connect(ROOT / "state.db") as con:
    con.execute("UPDATE cvis_schedule SET next_due_at=? WHERE id=?", (NOW - 1000, sch))
    con.commit()
rc, out = cli("cvis", "schedule-tick", "--owner", "runner-1")
claimed = json.loads(out) if rc == 0 else None
check("due schedule is reclaimable on the next tick", rc == 0 and claimed and claimed["id"] == sch, out)
roundtrip, evidence = probe_alias(PROVIDER_URL)
rc, out = cli("cvis", "schedule-complete", sch, "--owner", "runner-1",
              "--status", "ok" if roundtrip else "failed")
check("failing probe completes the run as failed", rc == 0 and not roundtrip, evidence)
row = sql("SELECT last_status,consecutive_failures FROM cvis_schedule WHERE id=?", (sch,))[0]
check("failure counting tracks consecutive failures", row == ("failed", 1), row)

provider.shutdown()
counts = {"pass": sum(r["pass"] for r in RESULTS), "fail": sum(not r["pass"] for r in RESULTS), "total": len(RESULTS)}
(ROOT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
print("RESULT", json.dumps(counts), flush=True)
if counts["fail"]:
    raise SystemExit(1)
