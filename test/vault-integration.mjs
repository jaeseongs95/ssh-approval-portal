import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const check = (condition, label) => assert.ok(condition,label);
const hash = text => createHash('sha256').update(text).digest('hex');
const controllerPath=fileURLToPath(import.meta.url),workerPath=fileURLToPath(new URL('./vault-worker.fixture.mjs',import.meta.url));
function workerReady(child,preparationMs,applicationMs,label) {
  const start=performance.now(),points=[];
  let applicationAt,settled=false,timer;
  return new Promise((resolve,reject) => {
    const finish=(error,value) => {
      if(settled)return;settled=true;
      clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',spawnError);
      if(error){console.log(JSON.stringify({stage:'worker-startup',status:error.message,elapsedMs:Math.round(performance.now()-start),points}));reject(error);}else resolve(value);
    };
    const message=value => {
      if(value?.kind==='progress') {
        if(['config','client_imports','application_import','application','mcp_connect','ready'].includes(value.stage) && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs>=0)points.push({stage:value.stage,elapsedMs:value.elapsedMs});
        if(value.stage==='application' && applicationAt===undefined){
          applicationAt=performance.now();
          if(applicationAt-start>preparationMs)return finish(Error('WORKER_IMPORT_DEADLINE'));
          clearTimeout(timer);timer=setTimeout(()=>finish(Error(label)),applicationMs);
        }
      }else if(value?.kind==='ready'){
        const end=performance.now();
        if(applicationAt===undefined)return finish(Error('WORKER_MISSING_APPLICATION_MILESTONE'));
        if(end-applicationAt>applicationMs)return finish(Error(label));
        finish(undefined,{elapsedMs:Math.round(end-start),preparationMs:Math.round(applicationAt-start),applicationReadyMs:Math.round(end-applicationAt),points});
      }
      else if(value?.kind==='error')finish(Error('WORKER_BOOTSTRAP_ERROR'));
    };
    const exit=()=>finish(Error('WORKER_EXIT_BEFORE_READY')),spawnError=()=>finish(Error('WORKER_SPAWN_ERROR'));
    timer=setTimeout(()=>finish(Error('WORKER_IMPORT_DEADLINE')),preparationMs);
    child.on('message',message);child.once('exit',exit);child.once('error',spawnError);
  });
}
const elapsed = (promise, ms, label) => {
  let timer;
  return Promise.race([promise,new Promise((_,reject) => { timer=setTimeout(() => reject(Error(label)),ms); })]).finally(() => clearTimeout(timer));
};
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await elapsed(once(child,'exit'),10000,'CHILD_STOP_TIMEOUT'); }
  catch { child.kill('SIGKILL'); await elapsed(once(child,'exit'),5000,'CHILD_KILL_TIMEOUT'); }
}
function request(origin, path, { token, ca, method='GET', data }={}) {
  return new Promise((resolve,reject) => {
    const req=https.request(origin+path,{ method,ca,agent:false,headers:{ ...(token?{'X-Vault-Token':token}:{}), ...(data?{'Content-Type':'application/json'}:{}) } },res => {
      const chunks=[]; res.on('data',chunk => chunks.push(chunk)); res.on('error',() => reject(Error('ADMIN_RESPONSE')));
      res.on('end',() => { try { resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString()||'{}')}); } catch { reject(Error('ADMIN_JSON')); } });
    });
    req.on('error',() => reject(Error('ADMIN_CONNECTION'))); req.setTimeout(3000,() => req.destroy());
    req.end(data?JSON.stringify(data):undefined);
  });
}

async function protocol() {
  const { createVaultSecretStore } = await import('../src/adapters/secrets/vault-kv.mjs');
  const config=JSON.parse(await readFile(process.env.VAULT_FIXTURE_CONFIG,'utf8'));
  const key=await readFile(config.tls+'/vault-key.pem'), cert=await readFile(config.tls+'/vault-cert.pem');
  const token=config.readerToken, value=config.expectedKey;
  let handler, requests=0, leaks=0;
  const record={data:{data:{value},metadata:{version:1,created_time:'2026-01-01T00:00:00Z',deletion_time:'',destroyed:false}}};
  const server=https.createServer({key,cert},(req,res) => {
    requests++;
    check(req.method==='GET' && req.url==='/v1/secret/data/model-safety-api-key','PINNED_READ_PATH');
    check(req.headers['x-vault-token']===token,'PINNED_READER_TOKEN'); handler(req,res);
  });
  const sink=https.createServer({key,cert},(_req,res) => { leaks++;res.end('{}'); });
  await new Promise(resolve => server.listen(0,'0.0.0.0',resolve));
  await new Promise(resolve => sink.listen(0,'127.0.0.1',resolve));
  const origin=`https://127.0.0.1:${server.address().port}`;
  const store=createVaultSecretStore({origin,getToken:async () => token});
  const refused=async action => {
    let error;try { await action(); } catch(caught) { error=caught; }
    check(error?.message==='Secret operation refused' && !JSON.stringify(error).includes(token) && !JSON.stringify(error).includes(value) && !error.cause,'SANITIZED_REFUSAL');
  };
  try {
    handler=(_q,r) => {r.setHeader('Content-Type','application/json');r.end(JSON.stringify(record));};
    check(await store.read('model-safety-api-key')===value,'TLS_VALUE');
    const metadata=await store.describe('model-safety-api-key');
    check(metadata.revision==='1' && !JSON.stringify(metadata).includes(value),'METADATA_ONLY');
    handler=(_q,r) => {r.writeHead(302,{Location:`https://127.0.0.1:${sink.address().port}/steal`});r.end();};
    await refused(() => store.read('model-safety-api-key'));check(leaks===0,'NO_REDIRECT_OR_TOKEN_FORWARD');
    for (const code of [401,403,429,500]) {
      handler=(_q,r) => {r.writeHead(code,{'Content-Type':'application/json'});r.end(JSON.stringify({errors:[token,value]}));};
      await refused(() => store.read('model-safety-api-key'));
    }
    handler=(_q,r) => {r.writeHead(404);r.end();};check(await store.read('model-safety-api-key')===undefined,'MISSING_KEY');
    const invalid=[
      ['text/plain',Buffer.from(JSON.stringify(record)),{}],
      ['application/json',Buffer.from(JSON.stringify(record)),{'Content-Encoding':'gzip'}],
      ['application/json',Buffer.from([0xff]),{}],
      ['application/json',Buffer.from('{broken'),{}],
      ['application/json',Buffer.from(JSON.stringify({...record,data:{...record.data,metadata:{...record.data.metadata,destroyed:true}}})),{}],
      ['application/json',Buffer.from(JSON.stringify({...record,data:{...record.data,metadata:{...record.data.metadata,deletion_time:'2026-01-01T00:00:00Z'}}})),{}],
      ['application/json',Buffer.from(JSON.stringify({data:{data:{value:'x'.repeat(16385)},metadata:record.data.metadata}})),{}],
      ['application/json',Buffer.alloc(65537,120),{}],
      ['application/json',Buffer.from('{}'),{'X-Oversize':'x'.repeat(17000)}],
    ];
    for (const [type,body,headers] of invalid) {
      handler=(_q,r) => {r.writeHead(200,{'Content-Type':type,...headers});r.end(body);};
      await refused(() => store.read('model-safety-api-key'));
    }
    handler=(_q,r) => {r.writeHead(200,{'Content-Type':'application/json'});r.write(Buffer.alloc(40000,120));r.end(Buffer.alloc(40000,120));};
    await refused(() => store.read('model-safety-api-key'));
    handler=(_q,r) => {r.writeHead(200,{'Content-Type':'application/json'});r.write('{');r.socket.destroy();};
    await refused(() => store.read('model-safety-api-key'));
    handler=(_q,r) => {
      r.writeHead(200,{'Content-Type':'application/json'});r.write(' ');
      const interval=setInterval(() => r.write(' '),100);r.on('close',() => clearInterval(interval));
    };
    const start=Date.now();await refused(() => store.read('model-safety-api-key'));
    check(Date.now()-start>=4500 && Date.now()-start<9000,'ABSOLUTE_DRIBBLE_DEADLINE');
    handler=() => {};
    const headerStart=Date.now();await refused(() => store.read('model-safety-api-key'));
    check(Date.now()-headerStart>=4500 && Date.now()-headerStart<9000,'ABSOLUTE_HEADER_DEADLINE');
    const before=requests;
    const wrongHost=createVaultSecretStore({origin:`https://127.0.0.2:${server.address().port}`,getToken:async () => token});
    await refused(() => wrongHost.read('model-safety-api-key'));check(requests===before,'TLS_HOSTNAME_BEFORE_TOKEN');
    console.log(JSON.stringify({stage:'protocol',status:'PASS',malformedCases:invalid.length+1,permissionCases:4,redirectRequests:leaks,absoluteDeadline:true,headerDeadline:true,chunkedBodyBounded:true,hostnameVerified:true}));
  } finally { server.closeAllConnections();sink.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>sink.close(resolve))]); }
}

async function integration() {
  const diagnostic=process.argv[2]==='--startup-diagnostic';
  const root=await mkdtemp('/tmp/ssh-vault-'), tls=root+'/tls', storeRoot=root+'/secrets', configPath=root+'/worker.json';
  await mkdir(tls,{mode:0o700});await mkdir(storeRoot,{mode:0o700});
  // Fixed synthetic inputs for the baseline/candidate source comparison. Never a real credential.
  const seed='ssh-vault-local-comparison-v1', rootToken='fixture-root-'+hash(seed), tokenId='fixture-reader-'+hash(seed+'reader');
  const keyA=hash(seed+'key-a'), keyB=hash(seed+'key-b'), origin='https://127.0.0.1:8200';
  let vault, worker, lastPid, currentKey=keyA, ca, readerToken,lastStartup;
  const owned=new Set(),startupObservations=[];
  const startWorker=async (expectedKey,status='assessed',extra={}) => {
    const transferRoot=root+'/transfers-'+owned.size;await mkdir(transferRoot,{mode:0o700});
    const env={BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-admin',BRIDGE_ADMIN_ORIGIN:'https://example.test',BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_JEV_ENABLED:'true',BRIDGE_SECRET_STORE_DIR:storeRoot,BRIDGE_JEV_KEY_REF:'secret://vault/model-safety-api-key',BRIDGE_VAULT_URL:origin,BRIDGE_VAULT_MOUNT:'secret',BRIDGE_VAULT_TOKEN_REF:'secret://local-file/vault-reader-token',...extra};
    await writeFile(configPath,JSON.stringify({transferRoot,env,expectedKey,readerToken,tls}),{mode:0o600});
    worker=fork(workerPath,[],{env:{...process.env,NODE_EXTRA_CA_CERTS:tls+'/vault-ca.pem',VAULT_FIXTURE_CONFIG:configPath},stdio:['ignore','ignore','ignore','ipc']});
    owned.add(worker);
    lastStartup=await workerReady(worker,diagnostic?60000:30000,12000,'WORKER_READY_TIMEOUT');startupObservations.push(lastStartup);
    if(lastPid)check(worker.pid!==lastPid,'NEW_PROCESS_RESTART');lastPid=worker.pid;
    const result=await assess();check(result.status===status, status==='assessed'?'INITIAL_VAULT_ASSESSMENT':'FAIL_CLOSED_ASSESSMENT');
    return result;
  };
  const assess=async () => {
    const message=once(worker,'message');worker.send({kind:'assess'});
    const [result]=await elapsed(message,12000,'ASSESSMENT_TIMEOUT');check(result.kind==='assessment','PUBLIC_MCP_ASSESSMENT');
    check(result.calls===(result.status==='assessed'?1:0),'MODEL_CALL_COUNT');return result;
  };
  const stopWorker=async () => {
    const stopped=once(worker,'exit');worker.send({kind:'stop'});await elapsed(stopped,15000,'WORKER_STOP_TIMEOUT');check(worker.exitCode===0,'WORKER_CLEAN_EXIT');worker=undefined;
  };
  try {
    const elf=await readFile('/usr/local/bin/vault');const machine=elf.readUInt16LE(18);
    check(elf.subarray(0,4).equals(Buffer.from([127,69,76,70])) && machine===({x64:62,arm64:183})[process.arch],'ACTUAL_VAULT_NODE_ARCHITECTURE');
    vault=spawn('/usr/local/bin/vault',['server','-dev','-dev-tls','-dev-no-store-token',`-dev-tls-cert-dir=${tls}`,'-dev-listen-address=127.0.0.1:8200'],{env:{...process.env,VAULT_DEV_ROOT_TOKEN_ID:rootToken},stdio:'ignore'});
    const until=Date.now()+15000;let health;
    while(Date.now()<until && vault.exitCode===null) {
      try {ca=await readFile(tls+'/vault-ca.pem');health=await request(origin,'/v1/sys/health',{ca});if(health.status===200)break;}catch{}
      await sleep(100);
    }
    check(health?.status===200 && health.body.version==='2.0.3','REAL_VAULT_TLS_READY');
    const api=async (path,method='GET',data,token=rootToken) => request(origin,'/v1/'+path,{ca,token,method,data});
    check((await api('sys/policies/acl/fixture-reader','PUT',{policy:'path "secret/data/model-safety-api-key" { capabilities = ["read"] }'})).status===204,'READER_ACL');
    const created=await api('auth/token/create','POST',{id:tokenId,policies:['fixture-reader'],no_default_policy:true,ttl:'1h',renewable:false});
    check(created.status===200 && typeof created.body.auth?.client_token==='string','READER_TOKEN');readerToken=created.body.auth.client_token;
    const local=createLocalSecretStore(storeRoot);await local.init();await local.put('vault-reader-token',readerToken);
    check((await api('secret/data/model-safety-api-key','POST',{data:{value:keyA}})).status===200,'INITIAL_KEY_WRITE');
    check((await api('secret/data/other', 'GET',undefined,readerToken)).status===403,'READER_OTHER_PATH_DENIED');
    check((await api('secret/data/model-safety-api-key','POST',{data:{value:'denied'}},readerToken)).status===403,'READER_WRITE_DENIED');
    await startWorker(keyA);console.log(JSON.stringify({stage:'initial',status:'PASS',nodeArchitecture:process.arch,nodeVersion:process.version,platform:process.platform,vaultElfMachine:machine,vaultVersion:health.body.version}));
    if(diagnostic){await stopWorker();console.log(JSON.stringify({stage:'startup-diagnostic',status:'OBSERVED',lastStartup,networkDeadlineMs:5000,ordinaryPreparationMs:30000,applicationReadinessMs:12000,diagnosticPreparationMs:60000}));return;}
    check((await api('secret/data/model-safety-api-key','POST',{data:{value:keyB}})).status===200,'ROTATE_KEY');
    check((await assess()).status==='assessed','RUNNING_PROCESS_USES_CACHED_KEY_A');await stopWorker();
    currentKey=keyB;await startWorker(keyB);await stopWorker();
    check((await api('secret/data/model-safety-api-key','DELETE')).status===204,'SOFT_DELETE');
    await startWorker(keyB,'unavailable');await stopWorker();
    check((await api('secret/destroy/model-safety-api-key','PUT',{versions:[1,2]})).status===204,'PERMANENT_DESTROY');
    const destroyed=await api('secret/metadata/model-safety-api-key');check(destroyed.body.data?.versions?.['1']?.destroyed===true && destroyed.body.data?.versions?.['2']?.destroyed===true,'DESTROYED_VERSIONS');
    await startWorker(keyB,'unavailable');await stopWorker();
    check((await api('secret/data/model-safety-api-key','POST',{data:{value:keyB}})).status===200,'REPROVISION_KEY');
    await startWorker(keyB);
    check((await api('auth/token/revoke','POST',{token:readerToken})).status===204,'REVOKE_READER');
    check((await assess()).status==='assessed','RUNNING_PROCESS_CACHED_AFTER_REVOKE');await stopWorker();
    await startWorker(keyB,'unavailable');await stopWorker();
    // Env priority and disabled Jev must not depend on a now-revoked reader.
    await startWorker(keyB,'assessed',{JEV_API_KEY:keyB});await stopWorker();
    await startWorker(keyB,'unavailable',{BRIDGE_JEV_ENABLED:'false'});await stopWorker();
    await startWorker(keyB,'unavailable',{BRIDGE_VAULT_TOKEN_REF:'secret://local-file/missing-token'});await stopWorker();
    // Same endpoint without its private CA must fail before any model call.
    await writeFile(configPath,JSON.stringify({transferRoot:root+'/untrusted',expectedKey:keyB,readerToken,tls,env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-admin',BRIDGE_ADMIN_ORIGIN:'https://example.test',BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_JEV_ENABLED:'true',BRIDGE_SECRET_STORE_DIR:storeRoot,BRIDGE_JEV_KEY_REF:'secret://vault/model-safety-api-key',BRIDGE_VAULT_URL:origin,BRIDGE_VAULT_TOKEN_REF:'secret://local-file/vault-reader-token'}}),{mode:0o600});
    // A fresh valid reader isolates certificate failure from revoked-credential failure.
    const second=await api('auth/token/create','POST',{policies:['fixture-reader'],no_default_policy:true,ttl:'1h'});check(second.status===200,'SECOND_READER');
    readerToken=second.body.auth.client_token;await local.put('vault-reader-token',readerToken);
    await startWorker(keyB);await stopWorker();
    const untrustedConfig=JSON.parse(await readFile(configPath,'utf8'));untrustedConfig.transferRoot=root+'/untrusted';
    await writeFile(configPath,JSON.stringify(untrustedConfig),{mode:0o600});
    const childEnv={...process.env,VAULT_FIXTURE_CONFIG:configPath};delete childEnv.NODE_EXTRA_CA_CERTS;
    childEnv.NODE_TLS_REJECT_UNAUTHORIZED='0';
    worker=fork(workerPath,[],{env:childEnv,stdio:['ignore','ignore','ignore','ipc']});owned.add(worker);
    startupObservations.push(await workerReady(worker,30000,12000,'UNTRUSTED_READY'));
    check((await assess()).status==='unavailable','UNTRUSTED_CA_REJECTED');await stopWorker();
    const peer=spawn(process.execPath,[controllerPath,'--protocol'],{env:{...process.env,NODE_EXTRA_CA_CERTS:tls+'/vault-ca.pem',VAULT_FIXTURE_CONFIG:configPath},stdio:['ignore','pipe','ignore']});owned.add(peer);
    let publicOutput='';peer.stdout.on('data',chunk => {publicOutput+=chunk;});
    const [code]=await elapsed(once(peer,'exit'),30000,'PROTOCOL_TIMEOUT');check(code===0,'PROTOCOL_BOUNDARIES');
    check(!publicOutput.includes(readerToken) && !publicOutput.includes(currentKey),'PROTOCOL_NO_LEAK');process.stdout.write(publicOutput);
    console.log(JSON.stringify({stage:'lifecycle',status:'PASS',rotationAfterRestart:true,softDeleteNoOldFallback:true,destroyVerified:true,readerRevocationAfterRestart:true,runningCacheLifetimeExplicit:true,environmentPriority:true,disabledNoAuthority:true,missingTokenNoAuthority:true,untrustedCaRejected:true,startupObservations}));
  } finally {
    for (const child of owned) await terminate(child);
    await terminate(vault);
    check(root.startsWith('/tmp/ssh-vault-'),'OWNED_TEMP_ROOT');await rm(root,{recursive:true,force:true});
  }
}

try { if(process.argv[2]==='--protocol')await protocol();else await integration(); }
catch(error) { console.error(error?.message==='INITIAL_VAULT_ASSESSMENT'?'INITIAL_VAULT_ASSESSMENT':`VAULT_FIXTURE_FAILURE:${/^[A-Z_]+$/.test(error?.message??'')?error.message:'ASSERTION'}`);process.exitCode=1; }
