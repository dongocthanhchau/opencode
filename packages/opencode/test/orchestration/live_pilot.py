import base64
import json
import os
import socket
import shlex
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

BIN = os.environ.get("CVIS_TEST_BINARY", "/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode")
ROOT = Path(tempfile.mkdtemp(prefix="cvis-live-pilot-", dir="/tmp"))
HOME = ROOT / "home"
PROJECT = ROOT / "project"
HOME.mkdir()
PROJECT.mkdir()
(PROJECT / "src").mkdir()
(PROJECT / "src/pilot.ts").write_text("export function answer() { return 41 }\n")
subprocess.run(["git", "init", "--quiet", str(PROJECT)], check=True)
subprocess.run(["git", "-C", str(PROJECT), "add", "src/pilot.ts"], check=True)
subprocess.run(["git", "-C", str(PROJECT), "-c", "user.name=CVIS Test", "-c", "user.email=cvis-test@example.invalid", "commit", "--quiet", "-m", "test fixture"], check=True)
source = json.loads(Path("/home/chad/.config/opencode/opencode.json").read_text())
model = os.environ.get("CVIS_PILOT_MODEL", source["model"])
provider = model.split("/", 1)[0]
config = {"model": model, "small_model": model, "provider": {provider: source["provider"][provider]}, "plugin": [], "mcp": {}}
cfgdir = HOME / ".config/opencode"
cfgdir.mkdir(parents=True)
(cfgdir / "opencode.json").write_text(json.dumps(config))
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    PORT = sock.getsockname()[1]
DB = ROOT / "pilot.db"
ENV = dict(os.environ, HOME=str(HOME), XDG_CONFIG_HOME=str(HOME/".config"), XDG_DATA_HOME=str(HOME/".local/share"),
           OPENCODE_DB=str(DB), OPENCODE_SERVER_PASSWORD="pilot-local-password", OPENCODE_MEMORY_VAULT=str(ROOT/"vault"))
for line in Path("/etc/systemd/system/oc-opencode.service").read_text().splitlines():
    if line.startswith("Environment="):
        for item in shlex.split(line[len("Environment="):]):
            key, sep, value = item.partition("=")
            if sep and key.startswith("CVIS_"):
                ENV.setdefault(key, value)
AUTH = "Basic " + base64.b64encode(b"opencode:pilot-local-password").decode()
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json", "x-opencode-directory": str(PROJECT)}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
RESULTS = []
server = None
log = None


def api(method, path, body=None, timeout=240, auth=True):
    headers = HEADERS if auth else {}
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        return error.code, json.loads(raw) if raw.startswith("{") else raw[:500]


def start():
    global server, log
    log = (ROOT/"server.log").open("ab")
    server = subprocess.Popen([BIN,"serve","--port",str(PORT),"--hostname","127.0.0.1","--pure"], cwd=PROJECT,
                              env=ENV, stdout=log, stderr=log)
    for _ in range(60):
        if server.poll() is not None:
            raise RuntimeError("Scratch server exited; inspect " + str(ROOT/"server.log"))
        try:
            status, _ = api("GET", "/global/health", timeout=2)
            if status == 200:
                return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError("Scratch server did not become healthy")


def stop():
    if server and server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=15)
    if log:
        log.close()


def check(name, ok, evidence=None):
    row = {"name":name,"pass":bool(ok),"evidence":evidence}
    RESULTS.append(row)
    print(json.dumps(row,ensure_ascii=False),flush=True)
    if not ok:
        raise AssertionError(name)


def sql(query, params=()):
    with sqlite3.connect(DB) as con:
        con.row_factory = sqlite3.Row
        return [dict(r) for r in con.execute(query,params).fetchall()]


def prompt_manager(sid,text):
    code,response = api("POST",f"/session/{sid}/message",{"agent":"build","parts":[{"type":"text","text":text}]})
    check("manager model turn",code==200 and "info" in response and not response["info"].get("error"),
          {"http":code,"error":response.get("info",{}).get("error") if isinstance(response,dict) else response})
    return response


try:
    start()
    code, _ = api("GET", "/cvis/projects/global", auth=False)
    check("Cvis API requires authentication", code==401, code)
    code, mgr = api("POST", "/session", {"title":"CVIS pilot manager","agent":"build"})
    check("real V1 manager session admission",code==200 and "id" in mgr, {"id":mgr.get("id")})
    sid = mgr["id"]
    pid = mgr["projectID"]
    check("pilot uses a real project identity rather than global fallback",pid!="global",pid)
    code, body = api("POST", "/cvis/bind", {"sessionID":sid,"projectID":pid,"role":"manager"})
    check("runtime manager binding",code==200,body)
    cli = subprocess.run([BIN,"cvis","goal-create","--project",pid,"--title","Pilot 42","--objective",
                          "src/pilot.ts must export answer() returning 42. Independent verifier must inspect actual code. Preserve task constraints.",
                          "--budget",os.environ.get("CVIS_PILOT_BUDGET","300000"),"--pure"],cwd=PROJECT,env=ENV,capture_output=True,text=True,timeout=90)
    goals = sql("SELECT id FROM cvis_project_goal WHERE project_id=?",(pid,))
    check("goal admission",cli.returncode==0 and len(goals)==1,{"rc":cli.returncode,"count":len(goals)})
    gid = goals[0]["id"]
    code,body = api("POST","/cvis/command",{"actor":sid,"operation":"goal_status","arguments":{"goalID":gid,"status":"active"}})
    check("manager activates project goal",code==200,body)
    prompt_manager(sid,
      f"This is an integration test of agent recovery. Project goal ID: {gid}. Call cvis_create_task to create EXACTLY ONE implementer task, then cvis_queue_task. "
      "title='Pilot answer'; description='FIRST PHASE: inspect src/pilot.ts and report its current value. Do not modify the file in this phase. The verifier should detect that delivery is not yet correct.' "
      "scope={read_paths:['src'],write_paths:['src'],tools:[]}; acceptance=[{id:'answer',label:'src/pilot.ts exports answer() returning 42',weight:100}]. "
      "Supply fields directly to cvis_create_task including goalID, then cvis_queue_task with taskID. Do not use cvis_control or nest arguments. Do not edit source, fabricate results, or mark Done.")
    tasks = sql("SELECT * FROM cvis_task WHERE project_id=? AND role='implementer'",(pid,))
    check("manager actually creates and queues task with tool",len(tasks)==1 and tasks[0]["status"]=="queued", [{"id":t["id"],"status":t["status"]} for t in tasks])
    tid = tasks[0]["id"]
    code,result = api("POST","/cvis/pump",{"managerSessionID":sid},timeout=480)
    check("first real worker/verifier cycle detects failure",code==200 and isinstance(result,list) and any(r["status"]=="failed" for r in result),result)
    check("failure is real artifact review",bool(sql("SELECT id FROM cvis_check WHERE task_id=? AND verdict='fail'",(tid,))),sql("SELECT check_id,verdict,evidence FROM cvis_check WHERE task_id=?",(tid,)))
    check("incorrect source was not counted Done",sql("SELECT status FROM cvis_task WHERE id=?",(tid,))[0]["status"]!="done")
    before = sql("SELECT id,status,attempt FROM cvis_task_run")
    stop()
    start()
    check("server restart preserves runs",sql("SELECT id,status,attempt FROM cvis_task_run")==before)
    prompt_manager(sid,
      f"Resume from the durable snapshot. Task {tid} failed independent review as expected. "
      "Use cvis_revise_task with this taskID and description='Now implement src/pilot.ts so answer() returns 42. Use edit/write tools only inside src. No shell.' "
      "Then cvis_queue_task the same taskID. Supply fields directly, no nested arguments. Preserve acceptance and scope. Do not verify your own work or mark Done.")
    check("real manager repairs the plan",sql("SELECT status,revision FROM cvis_task WHERE id=?",(tid,))[0]=={"status":"queued","revision":2})
    old_worker=sql("SELECT session_id FROM cvis_task_run WHERE task_id=? AND attempt=1",(tid,))[0]["session_id"]
    check("archive former worker through real API",api("PATCH",f"/session/{old_worker}",{"time":{"archived":int(time.time()*1000)}})[0]==200)
    code,result = api("POST","/cvis/pump",{"managerSessionID":sid},timeout=480)
    check("real repaired worker/verifier cycle",code==200 and isinstance(result,list) and any(r["status"]=="done" for r in result),result)
    next_worker=sql("SELECT session_id FROM cvis_task_run WHERE task_id=? AND attempt=2",(tid,))[0]["session_id"]
    check("pump creates eligible replacement instead of reviving archived worker",next_worker!=old_worker and sql("SELECT time_archived FROM session WHERE id=?",(old_worker,))[0]["time_archived"] is not None,{"old":old_worker,"replacement":next_worker})
    check("implementation artifact exists and is changed", "42" in (PROJECT/"src/pilot.ts").read_text(), (PROJECT/"src/pilot.ts").read_text())
    check("independent artifact receipt recorded",bool(sql("SELECT id FROM cvis_check WHERE task_id=? AND verdict='pass' AND revision=2",(tid,))))
    check("verified task completed",sql("SELECT status FROM cvis_task WHERE id=?",(tid,))[0]["status"]=="done")
    check("separate worker and verifier sessions",len(sql("SELECT DISTINCT session_id FROM cvis_task_run"))>=2)
    prompt_manager(sid,f"Use cvis_snapshot to verify completion, then cvis_goal_status with goalID={gid}, status=completed directly. Do not cancel any task to inflate progress. Report actual results.")
    check("project goal evidence gate closes after actual work",sql("SELECT status FROM cvis_project_goal WHERE id=?",(gid,))[0]["status"]=="completed")
    code,snapshot = api("GET",f"/cvis/projects/{pid}")
    check("HTTP snapshot reflects verified completion",code==200 and snapshot["goals"][0]["percent"]==100,snapshot)
    code,body=api("POST",f"/session/{sid}/summarize",{"providerID":provider,"modelID":model.split("/",1)[1],"auto":False},timeout=240)
    check("real V1 compaction completes",code==200,body)
    memories=[]
    for _ in range(120):
        memories=sql("SELECT id,project_id,vault_path FROM memory_fact WHERE session_id=?",(sid,))
        if memories and memories[0]["vault_path"]:break
        time.sleep(.5)
    items=sql("SELECT id,project_id FROM memory_item WHERE session_id=?",(sid,))
    check("compaction automatically captures project memory without capture CLI",bool(memories) and bool(items) and all(row["project_id"]==pid for row in memories+items),{"facts":len(memories),"items":len(items)})
    check("automatic capture publishes note for committed facts",bool(memories) and memories[0]["vault_path"] is not None and Path(memories[0]["vault_path"]).exists(),memories)
    print("PILOT_ROOT",ROOT,flush=True)
finally:
    stop()
    (ROOT/"results.json").write_text(json.dumps(RESULTS,ensure_ascii=False,indent=2))
    print("RESULT",json.dumps({"pass":sum(r["pass"] for r in RESULTS),"fail":sum(not r["pass"] for r in RESULTS),"root":str(ROOT)}),flush=True)
