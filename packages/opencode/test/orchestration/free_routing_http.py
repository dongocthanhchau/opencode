import base64
import http.server
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT=Path(tempfile.mkdtemp(prefix='cvis-free-routing-',dir='/tmp'))
HOME=ROOT/'home';WORK=ROOT/'project';HOME.mkdir();WORK.mkdir()
CALLS=[];RESULTS=[]
class Provider(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        name=payload['model'];CALLS.append(name)
        if name in ['free-primary','lite-fallback']:
            self.send_response(410 if name=='free-primary' else 503);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'error':{'message':'Model has been deprecated' if name=='free-primary' else 'service unavailable'}}).encode());return
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        chunks=[{'id':'test','object':'chat.completion.chunk','created':1,'model':name,'choices':[{'index':0,'delta':{'role':'assistant','content':'READY'},'finish_reason':None}]},{'id':'test','object':'chat.completion.chunk','created':1,'model':name,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':1,'total_tokens':101}}]
        for chunk in chunks:self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self,*args):pass
provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
with socket.socket() as sock:sock.bind(('127.0.0.1',0));PORT=sock.getsockname()[1]
providers={}
for pid,name in [('opencode','free-primary'),('cvis-litellm','lite-fallback'),('cline','cline-fallback')]:
    providers[pid]={'npm':'@ai-sdk/openai-compatible','options':{'baseURL':f'http://127.0.0.1:{provider.server_port}/v1','apiKey':'test'},'whitelist':[name],'models':{name:{'name':name,'tool_call':True,'limit':{'context':100000,'output':4096},'cost':{'input':0,'output':0}}}}
cfg=HOME/'.config/opencode';cfg.mkdir(parents=True)
(cfg/'opencode.json').write_text(json.dumps({'model':'cline/cline-fallback','small_model':'cline/cline-fallback','provider':providers,'enabled_providers':list(providers),'plugin':[],'mcp':{}}))
env=dict(os.environ,HOME=str(HOME),XDG_CONFIG_HOME=str(HOME/'.config'),XDG_DATA_HOME=str(HOME/'.local/share'),OPENCODE_DB=str(ROOT/'db.sqlite'),OPENCODE_SERVER_PASSWORD='test',CVIS_MODEL_ROUTING='opencode-first')
headers={'Authorization':'Basic '+base64.b64encode(b'opencode:test').decode(),'Content-Type':'application/json','x-opencode-directory':str(WORK)}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(method,path,body=None):
    req=urllib.request.Request(f'http://127.0.0.1:{PORT}'+path,headers=headers,method=method,data=json.dumps(body).encode() if body is not None else None)
    with opener.open(req,timeout=120) as response:return json.load(response)
def check(name,ok,evidence=None):
    RESULTS.append({'name':name,'pass':bool(ok),'evidence':evidence});print(json.dumps(RESULTS[-1]),flush=True)
    if not ok:raise AssertionError(name)
log=(ROOT/'server.log').open('wb')
binary='/home/chad/opencode-fork/packages/opencode/dist/opencode-linux-x64/bin/opencode'
server=subprocess.Popen([binary,'serve','--port',str(PORT),'--hostname','127.0.0.1','--pure'],cwd=WORK,env=env,stdout=log,stderr=log)
try:
    for _ in range(60):
        try:
            if api('GET','/global/health'):break
        except OSError:time.sleep(.5)
    manager=api('POST','/session',{'title':'Routing manager'})
    api('POST','/cvis/bind',{'sessionID':manager['id'],'projectID':manager['projectID'],'role':'manager'})
    response=api('POST',f"/session/{manager['id']}/message",{'agent':'build','parts':[{'type':'text','text':'Reply READY only. No tools.'}]})
    check('OpenCode failure routes through LiteLLM then Cline',CALLS==['free-primary','lite-fallback','cline-fallback'],CALLS)
    check('actual transcript records successful fallback provider',response['info']['providerID']=='cline' and not response['info'].get('error'),response['info'].get('providerID'))
    check('fallback delivers response',any(part.get('text')=='READY' for part in response['parts']))
    before=len(CALLS)
    api('POST',f"/session/{manager['id']}/message",{'agent':'build','parts':[{'type':'text','text':'Reply READY only again.'}]})
    check('cooldown avoids repeating failing providers',CALLS[before:]==['cline-fallback'],CALLS[before:])
    ordinary=api('POST','/session',{'title':'Unmanaged model pin'})
    before=len(CALLS)
    api('POST',f"/session/{ordinary['id']}/message",{'agent':'build','model':{'providerID':'cline','modelID':'cline-fallback'},'parts':[{'type':'text','text':'Reply READY only.'}]})
    check('unmanaged explicit selection remains untouched',CALLS[before:]==['cline-fallback'],CALLS[before:])
finally:
    server.terminate()
    try:server.wait(timeout=10)
    except subprocess.TimeoutExpired:server.kill();server.wait()
    log.close();provider.shutdown()
    (ROOT/'results.json').write_text(json.dumps(RESULTS,indent=2))
    print('REPORT',ROOT,flush=True)
