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
import urllib.error
import urllib.request
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-http-faults-",dir="/tmp"))
HOME = ROOT/"home"
WORK = ROOT/"project"
HOME.mkdir()
WORK.mkdir()
(WORK/"src").mkdir()
(WORK/"src/code.ts").write_text("export const value = 42\n")
subprocess.run(["git","init","--quiet",str(WORK)],check=True)
CALLED = threading.Event()


class DelayedProvider(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length","0")))
        CALLED.set()
        time.sleep(30)
        try:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"error":"test provider delayed"}')
        except (BrokenPipeError,ConnectionResetError):
            pass

    def log_message(self,*args):
        pass


provider = http.server.ThreadingHTTPServer(("127.0.0.1",0),DelayedProvider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
with socket.socket() as sock:
    sock.bind(("127.0.0.1",0))
    PORT = sock.getsockname()[1]
cfg = HOME/".config/opencode"
cfg.mkdir(parents=True)
(cfg/"opencode.json").write_text(json.dumps({"model":"delay/stall","small_model":"delay/stall","plugin":[],"mcp":{},
    "provider":{"delay":{"npm":"@ai-sdk/openai-compatible","name":"fault injection",
    "options":{"baseURL":f"http://127.0.0.1:{provider.server_port}/v1","apiKey":"test-only"},
    "models":{"stall":{"name":"stall","limit":{"context":32000,"output":1000}}}}}}))
DB = ROOT/"state.db"
ENV = dict(os.environ,HOME=str(HOME),XDG_CONFIG_HOME=str(HOME/".config"),XDG_DATA_HOME=str(HOME/".local/share"),OPENCODE_DB=str(DB),OPENCODE_SERVER_PASSWORD="test-only",CVIS_RUN_LEASE_MS="4000")
HEADERS = {"Authorization":"Basic "+base64.b64encode(b"opencode:test-only").decode(),"Content-Type":"application/json","x-opencode-directory":str(WORK)}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
RESULTS = []
server = None
log = None


def api(method,path,body=None,timeout=30):
    req=urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",headers=HEADERS,method=method,data=json.dumps(body).encode() if body is not None else None)
    try:
        with OPENER.open(req,timeout=timeout) as response:
            raw=response.read().decode()
            return response.status,json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw=error.read().decode()
        return error.code,json.loads(raw) if raw.startswith("{") else raw


def start():
    global server,log
    log=(ROOT/"server.log").open("ab")
    server=subprocess.Popen([BIN,"serve","--port",str(PORT),"--hostname","127.0.0.1","--pure"],cwd=WORK,env=ENV,stdout=log,stderr=log)
    for _ in range(60):
        try:
            if api("GET","/global/health",timeout=1)[0]==200:return
        except OSError:pass
        if server.poll() is not None:raise RuntimeError("server startup failed")
        time.sleep(.5)
    raise RuntimeError("server not healthy")


def stop():
    if server and server.poll() is None:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
    if log:log.close()


def check(name,ok,evidence=None):
    row={"name":name,"pass":bool(ok),"evidence":evidence}
    RESULTS.append(row)
    print(json.dumps(row),flush=True)
    if not ok:raise AssertionError(name)


def sql(query,params=()):
    with sqlite3.connect(DB) as con:
        con.row_factory=sqlite3.Row
        return [dict(r) for r in con.execute(query,params)]


try:
    start()
    _,manager=api("POST","/session",{"title":"fault manager"})
    _,worker=api("POST","/session",{"title":"fault worker"})
    pid=manager["projectID"]
    check("bind manager",api("POST","/cvis/bind",{"sessionID":manager["id"],"projectID":pid,"role":"manager"})[0]==200)
    args={"title":"Paused request","description":"Inspect src/code.ts","role":"implementer","scope":{"read_paths":["src"],"write_paths":["src"]},"acceptance":[{"id":"read","label":"Inspect source","weight":100}]}
    _,task=api("POST","/cvis/command",{"actor":manager["id"],"operation":"create_task","arguments":args})
    tid=task["id"]
    check("queue task",api("POST","/cvis/command",{"actor":manager["id"],"operation":"queue_task","arguments":{"taskID":tid}})[0]==200)
    outcome=[]
    def execute():
        try:outcome.append(api("POST",f"/cvis/tasks/{tid}/execute",{"sessionID":worker["id"]},timeout=90))
        except Exception as error:outcome.append(str(error))
    thread=threading.Thread(target=execute,daemon=True)
    thread.start()
    check("actual V1 request reaches delayed provider",CALLED.wait(30))
    code,body=api("POST","/cvis/command",{"actor":manager["id"],"operation":"pause_task","arguments":{"taskID":tid}},timeout=15)
    check("pause accepted while model is in flight",code==200,body)
    thread.join(timeout=15)
    check("pause actually interrupts the running request",not thread.is_alive(),outcome)
    check("paused task cannot be overwritten by late response",sql("SELECT status FROM cvis_task WHERE id=?",(tid,))[0]["status"]=="paused")
    check("cancelled run persisted",sql("SELECT status FROM cvis_task_run WHERE task_id=?",(tid,))[0]["status"]=="cancelled")
    check("worker released",sql("SELECT status,task_id FROM cvis_session_binding WHERE session_id=?",(worker["id"],))[0]=={"status":"idle","task_id":None})
    stop()
    start()
    check("real server restart retains paused checkpoint",sql("SELECT status FROM cvis_task WHERE id=?",(tid,))[0]["status"]=="paused")
    _,events=api("GET",f"/cvis/projects/{pid}/events?limit=500")
    check("event cursors strictly increase",all(a["cursor"]<b["cursor"] for a,b in zip(events,events[1:])),len(events))
    cursor=events[-1]["cursor"]
    check("reconnect returns no already consumed events",api("GET",f"/cvis/projects/{pid}/events?cursor={cursor}")[1]==[])
    req=urllib.request.Request(f"http://127.0.0.1:{PORT}/cvis/projects/{pid}/stream",headers=HEADERS)
    with OPENER.open(req,timeout=10) as response:
        lines=[]
        while True:
            line=response.readline().decode().strip()
            lines.append(line)
            if line.startswith("data:"):break
        check("SSE stream sends durable event ID",any(line.startswith("id:") for line in lines) and response.headers.get("Content-Type","").startswith("text/event-stream"),lines[:4])
    check("paused task can be requeued",api("POST","/cvis/command",{"actor":manager["id"],"operation":"queue_task","arguments":{"taskID":tid}})[0]==200)
    CALLED.clear()
    thread=threading.Thread(target=execute,daemon=True)
    thread.start()
    check("resumed V1 execution reaches provider",CALLED.wait(30))
    active=sql("SELECT active_run_id FROM cvis_task WHERE id=?",(tid,))[0]["active_run_id"]
    server.kill()
    server.wait(timeout=10)
    log.close()
    thread.join(timeout=10)
    time.sleep(5)
    start()
    code,recovered=api("POST",f"/cvis/projects/{pid}/recover")
    check("actual mid-execution crash recovered by lease",code==200 and any(row["runID"]==active for row in recovered),recovered)
    check("crashed execution marked interrupted without automatic rerun",sql("SELECT status FROM cvis_task WHERE id=?",(tid,))[0]["status"]=="paused" and sql("SELECT status FROM cvis_task_run WHERE id=?",(active,))[0]["status"]=="failed")
    check("recovery releases worker",sql("SELECT status,task_id FROM cvis_session_binding WHERE session_id=?",(worker["id"],))[0]=={"status":"idle","task_id":None})
finally:
    stop()
    provider.shutdown()
    (ROOT/"results.json").write_text(json.dumps(RESULTS,indent=2))
    print("RESULT",json.dumps({"pass":sum(r["pass"] for r in RESULTS),"fail":sum(not r["pass"] for r in RESULTS),"root":str(ROOT)}),flush=True)
