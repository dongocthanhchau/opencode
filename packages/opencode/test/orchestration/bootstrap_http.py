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

BIN=os.environ.get('CVIS_TEST_BINARY','/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode')
ROOT=Path(tempfile.mkdtemp(prefix='cvis-p01-http-',dir='/tmp'))
HOME=ROOT/'home'; WORK=ROOT/'project'; HOME.mkdir(); WORK.mkdir(); (WORK/'src').mkdir()
(WORK/'src/code.ts').write_text('export const answer = 42\n')
DB=ROOT/'state.db'; RESULTS=[]; REQUESTS=[]; MODE='timeout'; CALLS=0
class Provider(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global CALLS
        payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        REQUESTS.append(payload); CALLS+=1
        if CALLS>1 and MODE=='timeout':
            time.sleep(10)
            return
        usage=500000 if MODE=='exhaust' else 100
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        chunks=[{'id':'chat-test','object':'chat.completion.chunk','created':1,'model':'fake','choices':[{'index':0,'delta':{'role':'assistant','tool_calls':[{'index':0,'id':'call_read','type':'function','function':{'name':'read','arguments':json.dumps({'filePath':str(WORK/'src/code.ts')})}}]},'finish_reason':None}]},
        {'id':'chat-test','object':'chat.completion.chunk','created':1,'model':'fake','choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}],'usage':{'prompt_tokens':usage,'completion_tokens':10,'total_tokens':usage+10}}]
        try:
            for chunk in chunks:self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass
provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
with socket.socket() as sock:sock.bind(('127.0.0.1',0)); PORT=sock.getsockname()[1]
cfg=HOME/'.config/opencode';cfg.mkdir(parents=True)
(cfg/'opencode.json').write_text(json.dumps({'model':'fake/model','small_model':'fake/model','plugin':[],'mcp':{},'provider':{'fake':{'npm':'@ai-sdk/openai-compatible','options':{'baseURL':f'http://127.0.0.1:{provider.server_port}/v1','apiKey':'test'},'models':{'model':{'name':'fake','limit':{'context':100000,'output':20000}}}}}}))
ENV=dict(os.environ,HOME=str(HOME),XDG_CONFIG_HOME=str(HOME/'.config'),XDG_DATA_HOME=str(HOME/'.local/share'),OPENCODE_DB=str(DB),OPENCODE_SERVER_PASSWORD='test',CVIS_EXECUTION_TIMEOUT_MS='2500')
HEADERS={'Authorization':'Basic '+base64.b64encode(b'opencode:test').decode(),'Content-Type':'application/json','x-opencode-directory':str(WORK)}
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(method,path,body=None):
    req=urllib.request.Request(f'http://127.0.0.1:{PORT}{path}',headers=HEADERS,method=method,data=json.dumps(body).encode() if body is not None else None)
    try:
        with OPENER.open(req,timeout=30) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as error:return error.code,json.loads(error.read())
def require(result):
    if result[0]!=200:raise RuntimeError(str(result))
    return result[1]
def sql(query,args=()):
    with sqlite3.connect(DB) as c:return c.execute(query,args).fetchall()
def check(name,passed,evidence=None):
    row={'name':name,'pass':bool(passed),'evidence':evidence};RESULTS.append(row);print(json.dumps(row),flush=True)
    if not passed:raise AssertionError(name)
def command(actor,operation,args):return api('POST','/cvis/command',{'actor':actor,'operation':operation,'arguments':args})
def create_task(manager,title,role='implementer',scope=None,acceptance=None):
    return require(command(manager,'create_task',{'title':title,'description':'Inspect src/code.ts within scope.','role':role,'scope':scope or {'read_paths':['src'],'write_paths':[],'tools':[],'max_tokens':300000},'acceptance':acceptance or [{'id':'check','label':'Actual artifact','weight':100}]}))
log=(ROOT/'server.log').open('wb')
server=subprocess.Popen([BIN,'serve','--hostname','127.0.0.1','--port',str(PORT),'--pure'],cwd=WORK,env=ENV,stdout=log,stderr=log)
try:
    for _ in range(80):
        try:
            if api('GET','/global/health')[0]==200:break
        except OSError:time.sleep(.25)
    manager=require(api('POST','/session',{'title':'manager'})); pid=manager['projectID']; mid=manager['id']
    require(api('POST','/cvis/bind',{'sessionID':mid,'projectID':pid,'role':'manager'}))
    task=create_task(mid,'partial timeout'); require(command(mid,'queue_task',{'taskID':task['id']}))
    worker=require(api('POST','/session',{'title':'timeout worker'}))
    result=require(api('POST',f"/cvis/tasks/{task['id']}/execute",{'sessionID':worker['id']}))
    check('actual partial provider execution times out honestly',result['status']=='failed',result['status'])
    check('failed run retains reported partial consumption',sql('SELECT tokens_used FROM cvis_task_run WHERE id=?',(result['runID'],))[0][0]==110,sql('SELECT tokens_used FROM cvis_task_run WHERE id=?',(result['runID'],)))
    check('provider request carries real output cap',bool(REQUESTS) and 0<REQUESTS[0].get('max_tokens',REQUESTS[0].get('max_completion_tokens',0))<=4096,list(REQUESTS[0]))
    MODE='exhaust';CALLS=0;REQUESTS.clear()
    target=create_task(mid,'stop after large usage',acceptance=[{'id':key,'label':key,'weight':25} for key in ['a','b','c','d']]);require(command(mid,'queue_task',{'taskID':target['id']}))
    other=require(api('POST','/session',{'title':'budget worker'}))
    result=require(api('POST',f"/cvis/tasks/{target['id']}/execute",{'sessionID':other['id']}))
    check('live exhaustion blocks second provider call',result['status']=='failed' and CALLS==1,{'status':result['status'],'calls':CALLS})
    check('reported usage never erased to fit cap',sql('SELECT tokens_used FROM cvis_task_run WHERE id=?',(result['runID'],))[0][0]>=500000)
    cap=sql('SELECT json_extract(scope,\'$.max_tokens\') FROM cvis_task WHERE id=?',(target['id'],))[0][0]
    check('operator task budget CAS updates through HTTP',command(mid,'task_budget',{'taskID':target['id'],'maxTokens':700000,'expectedMaxTokens':cap,'reason':'explicit test operator decision'})[0]==200)
    check('stale operator budget CAS rejected',command(mid,'task_budget',{'taskID':target['id'],'maxTokens':800000,'expectedMaxTokens':cap,'reason':'stale'})[0]!=200)
    check('worker cannot change budget',command(other['id'],'task_budget',{'taskID':target['id'],'maxTokens':900000,'expectedMaxTokens':700000,'reason':'escalation'})[0]!=200)
    with sqlite3.connect(DB) as c:
        c.execute("UPDATE cvis_task SET status='verifying',active_run_id=?,attempt=1 WHERE id=?",(result['runID'],target['id']))
        c.execute("UPDATE cvis_task_run SET status='verifying' WHERE id=?",(result['runID'],));c.commit()
    review=create_task(mid,'review',role='verifier',scope={'read_paths':['src'],'write_paths':[],'tools':[],'review_task_id':target['id'],'review_revision':1},acceptance=[{'id':'review','label':'review','weight':100}])
    reviewer=require(api('POST','/session',{'title':'verifier'}));require(api('POST','/cvis/bind',{'sessionID':reviewer['id'],'projectID':pid,'role':'verifier'}))
    with sqlite3.connect(DB) as c:c.execute('UPDATE cvis_session_binding SET task_id=? WHERE session_id=?',(review['id'],reviewer['id']));c.commit()
    evidence={'checkID':'a','verdict':'pass','files':[str(WORK/'src/code.ts')],'conclusion':'Actual fixture artifact'}
    wrong=command(reviewer['id'],'verify',{**evidence,'taskID':review['id']})
    check('wrong review job ID yields actionable target',wrong[0]!=200 and target['id'] in str(wrong[1]),wrong[1])
    bad=command(reviewer['id'],'verify',{**evidence,'checkID':'unknown'})
    check('unknown check error lists valid checks',bad[0]!=200 and 'a, b, c, d' in str(bad[1]),bad[1])
    for key in ['a','b','c','d']:
        check('omitted target resolves authoritative checklist '+key,command(reviewer['id'],'verify',{**evidence,'checkID':key})[0]==200)
    check('four distinct actual receipts recorded',len(sql('SELECT check_id FROM cvis_check WHERE task_id=?',(target['id'],)))==4)
finally:
    server.terminate()
    try:server.wait(timeout=10)
    except subprocess.TimeoutExpired:server.kill();server.wait()
    log.close();provider.shutdown()
    (ROOT/'results.json').write_text(json.dumps(RESULTS,indent=2))
    print('RESULT',json.dumps({'pass':sum(row['pass'] for row in RESULTS),'fail':sum(not row['pass'] for row in RESULTS),'root':str(ROOT)}),flush=True)
