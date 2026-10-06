#!/usr/bin/env python3
"""Isolated ATG service integration check. Only localhost and a temporary database.
Run after: cargo build -p dispenser-service
"""
import json, os, pathlib, socket, socketserver, sqlite3, struct, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = pathlib.Path(__file__).resolve().parents[2]
state = {'bad_modbus': False, 'http_ok': False, 'requests': 0, 'exports': []}
class Modbus(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        try:
            while True:
                req = b''
                while len(req) < 12:
                    chunk = self.request.recv(12-len(req))
                    if not chunk: return
                    req += chunk
                tid, proto, length, unit, fc, start, count = struct.unpack('>HHHBBHH', req)
                assert proto == 0 and length == 6 and fc == 3 and 0 < count <= 120
                state['requests'] += 1
                data = b''
                for word in range(start-999, start-999+count, 2):
                    tank, field = divmod(word//2, 6)
                    values = [1.5, 0.002, 20.0, tank*100.0, tank*100.0, 0.0]
                    raw = struct.pack('>f', values[field])
                    data += raw[2:] + raw[:2]  # CDAB controller
                response = struct.pack('>HHHBBB', tid, 0, len(data)+3, unit+int(state['bad_modbus']), 3, len(data)) + data
                self.request.sendall(response)
        except (OSError, ConnectionError): pass
class TcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
class Integration(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        state['exports'].append((payload, self.headers.get('Authorization'), state['http_ok']))
        self.send_response(200 if state['http_ok'] else 503)
        self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *_): pass

def eventually(check, timeout=15):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            result=check()
            if result: return result
        except (OSError, AssertionError, ValueError): pass
        time.sleep(.15)
    raise AssertionError('condition did not become true before timeout')

def main():
    work = pathlib.Path(tempfile.mkdtemp(prefix='atg-service-check-'))
    modbus = TcpServer(('127.0.0.1',0),Modbus)
    integration = ThreadingHTTPServer(('127.0.0.1',0),Integration)
    for server in (modbus,integration): threading.Thread(target=server.serve_forever,daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    cfg=json.loads((ROOT/'services/dispenser-service/site.mock.json').read_text())
    cfg['connection']['protocol']='mock'
    cfg['service'].update(port=port,db_path=str(work/'station.sqlite'),log_file=str(work/'service.log'),log_level='warn')
    cfg['service']['serial_log_file']=None
    cfg['sync'].update(enabled=False,backend_url='',api_key='',price_pull_enabled=False)
    cfg['tanks']=[];cfg['atg']=None
    config=work/'site.json';config.write_text(json.dumps(cfg))
    env=os.environ.copy()
    for key in ['API_URL','API_TOKEN','AUTH_USERNAME','AUTH_PASSWORD','AUTH_LOGIN_URL','AZS_SERIAL_LOG']:
        env.pop(key,None)
    proc=None;log=(work/'process.log').open('w')
    def start():
        return subprocess.Popen([str(ROOT/'target/debug/dispenser-service'),'--config',str(config),'run'],cwd=work,env=env,stdout=log,stderr=log)
    def call(path,body=None,token=None):
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+token
        req=Request(f'http://127.0.0.1:{port}'+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
        try:
            with urlopen(req,timeout=10) as response:return response.status,json.load(response)
        except HTTPError as e:
            return e.code,e.read().decode()
    def db_value(sql):
        with sqlite3.connect(work/'station.sqlite') as db:return db.execute(sql).fetchone()[0]
    try:
        proc=start();eventually(lambda:call('/health')[0]==200)
        for path,body in [('/admin/atg-config',None),('/admin/atg-config',{}),('/admin/atg-discover',None)]:
            assert call(path,body)[0]==401
        status,result=call('/admin/auth',{'pin':'0000'});assert status==200,result
        token=result['token'];pid=cfg['products'][0]['id']
        tanks=[{'tank_id':f'tank-{i+1}','product_id':pid,'label':f'Tank {i+1}','capacity_l':25000,'current_l':0} for i in range(12)]
        branch={'id':1,'external_station_id':42,'host':'127.0.0.1','port':modbus.server_address[1],'unit_id':7,'start_register':1000,'address_base':1,'register_count':144,'word_order':'CDAB','height_unit':'m',
                'slots':[{'slot':i+1,'tank_id':t['tank_id'],'product_id':pid,'type':'AI-92'} for i,t in enumerate(tanks)]}
        body={'enabled':True,'poll_interval_secs':1,'stale_after_secs':2,'modbus_timeout_secs':.5,'api_url':f'http://127.0.0.1:{integration.server_port}/levels','auth':{'api_token':'local-test-token'},'branches':[branch],'tanks':tanks}
        status,result=call('/admin/atg-config',body,token);assert status==200,result
        def snapshot():return call('/config')[1]['tanks']
        readings=eventually(lambda:(lambda r:r if len(r)==12 and all(t['reading_status']=='fresh' for t in r) else False)(snapshot()))
        assert readings[0]['current_l']==0 and readings[11]['current_l']==1100
        saved=call('/admin/atg-config',token=token)[1]
        assert saved['auth']['api_token_set'] and 'local-test-token' not in json.dumps(saved)
        discovery=call('/admin/atg-discover?host=127.0.0.1&port='+str(modbus.server_address[1])+'&unit_id=7&start_register=1000&address_base=1&register_count=144&word_order=CDAB',token=token)
        assert discovery[0]==200 and len(discovery[1]['devices'][0]['tanks'])==12,discovery
        assert discovery[1]['devices'][0]['tanks'][0]['product_volume']==0
        eventually(lambda:db_value('SELECT count(*) FROM atg_outbox')>0)
        assert db_value("SELECT json_extract(payload_json,'$.level_mm') FROM sync_queue WHERE entity_type='reservoir_reading' LIMIT 1")==1500
        first_time=readings[0]['updated_at_ms']
        eventually(lambda:snapshot()[0].get('updated_at_ms',0)>first_time)
        assert state['exports'][0][0]['metadata']['product_volume']==6600
        assert state['exports'][0][0]['metadata']['max_product_volume']==300000
        assert state['exports'][0][1]=='Bearer local-test-token'
        state['bad_modbus']=True
        eventually(lambda:all(t['reading_status']=='offline' for t in snapshot()))
        result=call('/wetstock/preview')[1]
        assert len(result)==1 and not result[0]['measured_available']
        assert call('/wetstock/preview?tank_id=tank-1')[0]==400
        assert call('/deliveries',{'product_id':pid,'delivered_l':10})[0]==400
        assert call('/deliveries',{'product_id':pid,'tank_id':'tank-1','delivered_l':10})[0]==200
        assert len(call('/deliveries?tank_id=tank-1')[1])==1
        assert call('/deliveries?tank_id=tank-2')[1]==[]
        assert call('/admin/atg-config',{'enabled':False,'auth':None},token)[0]==200
        disabled=eventually(lambda:(lambda r:r if len(r)==12 and all(t['reading_status']=='disabled' for t in r) else False)(snapshot()))
        assert all('updated_at_ms' not in t for t in disabled)
        saved=call('/admin/atg-config',token=token)[1];assert saved['auth'] is None and len(saved['branches'])==1
        before=state['requests'];time.sleep(1.3);assert state['requests']==before
        assert call('/admin/atg-config',{'enabled':True},token)[0]==200
        old_payload=eventually(lambda:db_value('SELECT payload_json FROM atg_outbox ORDER BY created_at,id LIMIT 1'))
        proc.terminate();proc.wait(timeout=10);proc=None
        state['bad_modbus']=False;state['http_ok']=True
        proc=start();eventually(lambda:call('/health')[0]==200)
        expected=json.loads(old_payload)
        eventually(lambda:any(p==expected and ok for p,auth,ok in state['exports']),30)
        assert all(auth is None for _,auth,ok in state['exports'] if ok)
        eventually(lambda:all(t['reading_status']=='fresh' for t in snapshot()))
        print('PASS: authenticated config, 12 tanks / one product, batched CDAB reads, metre conversion, empty tanks, failed export isolation, offline reconciliation, physical delivery IDs, disable/re-enable, credential clearing, durable restart replay')
        print('Artifacts:',work)
    finally:
        if proc:
            proc.terminate()
            try:proc.wait(timeout=10)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
        modbus.shutdown();integration.shutdown();modbus.server_close();integration.server_close();log.close()
if __name__=='__main__':main()
