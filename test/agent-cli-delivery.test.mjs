import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import ssh2 from 'ssh2';
import {SSHConnection} from 'ssh-mcp/build/ssh/connection.js';
import {executeAgentCli,executePythonSource} from '../src/adapters/ssh/vendor.mjs';
import {prepareAgentCliPlan} from '../src/adapters/ssh/agent-cli.mjs';
import {preparePythonSource} from '../src/adapters/ssh/python-source.mjs';
import {validateAgentRelease} from '../src/domain/agent-cli.mjs';

const binding={targetId:'fixture',targetRevision:'a'.repeat(64),profile:'fixture-write'};
const verify=()=>({...binding}),operationId='c'.repeat(48),expected='b'.repeat(64);
function release(provider){const name=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';return validateAgentRelease(provider,{name,version:'1.2.3',dist:{tarball:'https://registry.npmjs.org/'+name+'/-/'+name.split('/')[1]+'-1.2.3.tgz',integrity:'sha512-'+Buffer.alloc(64,7).toString('base64')}});}
function plan(action='inspect',provider='codex'){
 return prepareAgentCliPlan({action,provider,binding,...(['install','update'].includes(action)?{release:release(provider),expectedInstallationRevision:expected,expiresAt:301000,operationId}:action==='status'?{operationId,expectedIntentDigest:'d'.repeat(64)}:{})});
}
const inspection=provider=>({provider,managed:false,installed:false,version:null,active:null,login:'not_checked',installationRevision:expected});
function value(p,state){return p.agentCli.action==='inspect'?inspection(p.agentCli.provider):{provider:p.agentCli.provider,operationId:p.agentCli.operationId,intentDigest:p.agentCli.intentDigest,state:state??'completed',version:'1.2.3',login:'not_checked'};}
function fake(p,change={},acquire=()=>{}){
 const calls=[],profile={name:binding.profile,tty:false,readOnly:false,...change};let acquisitions=0;
 const connection={profile,async exec(command,options){calls.push({command,options});return {exitCode:0,stdout:JSON.stringify(value(p)),stderr:''};}};
 const registry={getProfile:()=>profile,async getOrCreate(){acquisitions++;await acquire();return connection;}};
 return {calls,connection,registry,get acquisitions(){return acquisitions;}};
}
const unknown=error=>/unknown|changed|requires|binding|plan|fields|required/i.test(error.message)&&!error.message.includes('SYNTHETIC_PRIVATE');

test('CLI-DELIVERY fixed timeouts and public projection cover both providers and all actions',async()=>{
 for(const provider of ['codex','claude'])for(const action of ['inspect','install','update','status']){
  const p=plan(action,provider),f=fake(p),outcome=await executeAgentCli(f.registry,p,verify);
  assert.equal(outcome.failed,false);assert.deepEqual(outcome.texts,[]);assert.equal(outcome.data.agentCli.provider,provider);assert.equal(outcome.data.agentCli.action,action);assert.equal(outcome.data.agentCli.login,'not_checked');
  assert.ok(Object.isFrozen(outcome.data.agentCli));assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,p.command);assert.equal(f.calls[0].options.stdin,p.stdin);assert.equal(f.calls[0].options.timeoutMs,['install','update'].includes(action)?930000:30000);
 }
});
test('CLI-DELIVERY generic Python source retains its existing timeout and redacted-text contract',async()=>{
 const p=preparePythonSource({...binding,source:"print('ok')\n",cwd:'/'}),f=fake(p);
 f.connection.exec=async(command,options)=>{f.calls.push({command,options});return {exitCode:0,stdout:'ok',stderr:''};};
 const outcome=await executePythonSource(f.registry,p,verify);assert.deepEqual(Object.keys(f.calls[0].options),['stdin']);assert.deepEqual(outcome,{failed:false,texts:['ok']});
});
test('CLI-DELIVERY fixed receipt digest matches the Python helper canonical JSON contract',()=>{
 const p=plan('install'),args=JSON.parse(p.manifest.argvJson);
 const data={provider:'codex',action:'install',version:'1.2.3',integrity:release('codex').integrity,expected,expires:301000};
 const result=spawnSync('/usr/bin/python3',['-I','-B','-c',"import hashlib,json,sys; print(hashlib.sha256((json.dumps(json.loads(sys.argv[1]),sort_keys=True,separators=(',',':'))+'\\n').encode()).hexdigest())",JSON.stringify(data)],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.equal(p.agentCli.intentDigest,result.stdout.trim());assert.equal(args[6],operationId);
});
test('CLI-DELIVERY generic or mutated source/metadata/argv plans are refused before connection',async()=>{
 const p=plan('install');
 const generic=preparePythonSource({...binding,source:"print('ok')\n",argv:JSON.parse(p.manifest.argvJson),cwd:'/'});
 for(const changed of [{...generic,agentCli:p.agentCli},{...p,stdin:p.stdin+'\n# changed\n'},{...p,stdin:'print(1)\n'},{...p,command:'id'},{...p,args:['-c','pass']},{...p,planDigest:'e'.repeat(64)},{...p,manifest:{...p.manifest,targetRevision:'e'.repeat(64)}},{...p,agentCli:{...p.agentCli,action:'inspect'}},{...p,agentCli:{...p.agentCli,intentDigest:'e'.repeat(64)}}]){
  const f=fake(p);await assert.rejects(()=>executeAgentCli(f.registry,changed,verify));assert.equal(f.acquisitions,0);assert.equal(f.calls.length,0);
 }
});
test('CLI-DELIVERY TTY/read-only/workdir, changed target and changed registry profile never dispatch',async()=>{
 const p=plan();
 for(const changes of [{tty:true},{readOnly:true},{workdir:'/tmp'}]){const f=fake(p,changes);await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);assert.equal(f.calls.length,0);}
 let changed=false;const f=fake(p,{},()=>{changed=true;});await assert.rejects(()=>executeAgentCli(f.registry,p,()=>({...binding,targetRevision:changed?'e'.repeat(64):binding.targetRevision})),unknown);assert.equal(f.calls.length,0);
 const other=fake(p);other.registry.getProfile=()=>({...other.connection.profile,user:'changed'});await assert.rejects(()=>executeAgentCli(other.registry,p,verify),unknown);assert.equal(other.calls.length,0);
});
test('CLI-DELIVERY private extras are discarded without redacting validated public hashes',async()=>{
 const p=plan(),f=fake(p);f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...inspection('codex'),private:'SYNTHETIC_PRIVATE',externalIdentity:{token:'SYNTHETIC_PRIVATE'}}),stderr:''});
 const outcome=await executeAgentCli(f.registry,p,verify);assert.equal(outcome.data.agentCli.installationRevision,expected);assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_PRIVATE'));assert.equal(Object.hasOwn(outcome.data.agentCli,'externalIdentity'),false);
});
test('CLI-DELIVERY managed and foreign installation paths remain distinct and typed',async()=>{
 const p=plan(),f=fake(p);
 for(const installed of [{...inspection('codex'),managed:true,installed:true,version:'1.2.3',active:'versions/1.2.3-'+'e'.repeat(16)},{...inspection('codex'),installed:true,version:null,active:'/usr/local/bin/codex'}]){
  f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify(installed),stderr:''});const outcome=await executeAgentCli(f.registry,p,verify);assert.equal(outcome.data.agentCli.managed,installed.managed);assert.equal(outcome.data.agentCli.active,installed.active);
 }
});
for(const [name,change] of [
 ['wrong provider',{provider:'claude'}],['false login',{login:'authenticated'}],['bad revision',{installationRevision:'SYNTHETIC_PRIVATE'}],['bad version',{version:'1.2.3;id'}],['false flags',{installed:'yes'}],['inactive path',{active:'/tmp/codex'}],['managed version/path mismatch',{managed:true,installed:true,version:'1.2.3',active:'versions/2.0.0-'+'e'.repeat(16)}],['foreign command mismatch',{installed:true,active:'/usr/bin/claude'}],
])test('CLI-DELIVERY refuses '+name+' without raw output',async()=>{
 const p=plan(),f=fake(p);f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...inspection('codex'),...change}),stderr:''});await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);
});
for(const [name,result] of [
 ['nonzero',{exitCode:1,stdout:JSON.stringify({state:'refused',error:'SYNTHETIC_PRIVATE'}),stderr:''}],
 ['signal',{exitCode:0,stdout:JSON.stringify(inspection('codex')),stderr:'',signal:'TERM'}],
 ['stderr',{exitCode:0,stdout:JSON.stringify(inspection('codex')),stderr:'SYNTHETIC_PRIVATE'}],
 ['invalid JSON',{exitCode:0,stdout:'SYNTHETIC_PRIVATE',stderr:''}],
 ['oversized valid JSON',{exitCode:0,stdout:JSON.stringify({...inspection('codex'),private:'x'.repeat(16384)}),stderr:''}],
])test('CLI-DELIVERY '+name+' remains unknown with no replay or private error',async()=>{
 const p=plan(),f=fake(p);let calls=0;f.connection.exec=async()=>{calls++;return result;};await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);assert.equal(calls,1);
});
test('CLI-DELIVERY dispatch exception is unknown and never replayed',async()=>{
 const p=plan(),f=fake(p);let calls=0;f.connection.exec=async()=>{calls++;throw Error('SYNTHETIC_PRIVATE');};await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);assert.equal(calls,1);
});
test('CLI-DELIVERY acquisition failure is private and an admitted plan is immutable across acquisition',async()=>{
 const p=plan('install'),f=fake(p,{},()=>{throw Error('SYNTHETIC_PRIVATE');});await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);assert.equal(f.calls.length,0);
 const submitted={...p,manifest:{...p.manifest},agentCli:{...p.agentCli}},other=fake(p,{},()=>{submitted.stdin='changed';submitted.agentCli.intentDigest='e'.repeat(64);});
 assert.equal((await executeAgentCli(other.registry,submitted,verify)).failed,false);assert.equal(other.calls[0].options.stdin,p.stdin);assert.equal(other.calls[0].command,p.command);
});
test('CLI-DELIVERY status preserves explicit remote states and generic failure while binding operation/intent',async()=>{
 const p=plan('status'),f=fake(p);
 for(const state of ['preparing','installing','completed','reused','failed','unknown']){
  f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...value(p,state),error:'SYNTHETIC_PRIVATE'}),stderr:''});const outcome=await executeAgentCli(f.registry,p,verify);assert.equal(outcome.data.agentCli.state,state);assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_PRIVATE'));if(state==='failed')assert.equal(outcome.data.agentCli.error,'INSTALL_FAILED');
 }
 f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({state:'not_found',operationId}),stderr:''});assert.equal((await executeAgentCli(f.registry,p,verify)).data.agentCli.state,'not_found');
 f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...value(p,'completed'),cleanupFailures:2}),stderr:''});assert.equal((await executeAgentCli(f.registry,p,verify)).data.agentCli.cleanupFailures,2);
 for(const change of [{operationId:'f'.repeat(48)},{intentDigest:'f'.repeat(64)},{provider:'claude'},{login:'authenticated'},{version:'latest'},{state:'safe'},{cleanupFailures:0},{cleanupFailures:-1},{cleanupFailures:'1'}]){f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...value(p),...change}),stderr:''});await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);}
 f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({state:'not_found',operationId,cleanupFailures:1}),stderr:''});await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);
});
test('CLI-DELIVERY install cannot report failed, wrong version or a different receipt intent as success',async()=>{
 const p=plan('install'),f=fake(p);
 for(const change of [{state:'failed'},{version:'1.2.4'},{intentDigest:'f'.repeat(64)}]){f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({...value(p),...change}),stderr:''});await assert.rejects(()=>executeAgentCli(f.registry,p,verify),unknown);}
});

const key=()=>generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
const fingerprint=hostKey=>'SHA256:'+createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/,'');

test('CLI-LOOPBACK exact helper executes inspection/status over pinned SSH and preserves authentication bytes',{timeout:30000},async t=>{
 assert.equal(process.platform,'linux');assert.equal(userInfo().uid,10001);const home=userInfo().homedir;assert.equal(home,'/tmp/cli-fixture-home');
 await mkdir(join(home,'.codex'),{recursive:true,mode:0o700});const auth=join(home,'.codex/auth.json'),authBytes=Buffer.from('SYNTHETIC_AUTH_PRESERVE');await writeFile(auth,authBytes,{mode:0o600,flag:'wx'});
 const hostKey=key(),clients=new Set(),children=new Set(),received=[];let current,fault='none',fixtureError;
 const server=new ssh2.Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client));client.on('authentication',request=>request.accept());
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('pty',(_accept,reject)=>reject());session.on('env',accept=>accept?.());
   session.on('exec',(accept,reject,info)=>{
    const p=current;if(info.command!==p.command){fixtureError='Wrong fixed receiver command';reject();return;}
    const stream=accept(),chunks=[];stream.on('error',()=>{});stream.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    stream.once('end',()=>{
     const bytes=Buffer.concat(chunks);received.push({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),expectedBytes:p.manifest.sourceBytes,expectedSha256:p.manifest.sourceSha256});
     let delivered=bytes;if(fault==='short')delivered=bytes.subarray(0,bytes.length-1);if(fault==='wrong'){delivered=Buffer.from(bytes);delivered[0]^=1;}
     const child=spawn(p.manifest.interpreter,p.args,{stdio:['pipe','pipe','pipe'],env:{...process.env,JEV_SYNTHETIC_PARENT_SECRET:'SYNTHETIC_PARENT_SECRET'}});children.add(child);child.stdin.on('error',()=>{});
     child.stdout.on('data',chunk=>stream.write(chunk));child.stderr.on('data',chunk=>stream.stderr.write(chunk));
     child.once('error',()=>{fixtureError='Python helper spawn failed';stream.exit(1);stream.end();});child.once('close',code=>{children.delete(child);stream.exit(Number.isInteger(code)?code:1);stream.end();});
     stream.once('close',()=>{if(child.exitCode===null)child.kill();});child.stdin.end(delivered);
    });
   });
  }));
 });
 let connection;
 t.after(async()=>{await connection?.close();for(const child of children)child.kill();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));assert.equal(home,'/tmp/cli-fixture-home');await rm(home,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const profile={name:binding.profile,host:'127.0.0.1',port:server.address().port,user:'synthetic',auth:'key',trustedHostKey:fingerprint(hostKey),readOnly:false,tty:false,announceAgent:false,timeout:8000,maxOutputBytes:65536};
 connection=new SSHConnection(profile,{privateKey:key()},new Map(),'strict');const registry={getProfile:()=>profile,async getOrCreate(){await connection.ensureConnected();return connection;}};
 current=plan();const outcome=await executeAgentCli(registry,current,verify);assert.equal(outcome.data.agentCli.provider,'codex');assert.equal(outcome.data.agentCli.login,'not_checked');assert.match(outcome.data.agentCli.installationRevision,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(outcome).includes('SYNTHETIC_'));
 const install=plan('install'),work=join(home,'.local/share/ssh-approval-cli/codex/operations',operationId);await mkdir(work,{recursive:true,mode:0o700});
 await writeFile(join(work,'receipt.json'),JSON.stringify({provider:'codex',operationId,intentDigest:install.agentCli.intentDigest,state:'failed',version:'1.2.3',login:'not_checked',error:'INSTALL_FAILED'}),{mode:0o600,flag:'wx'});
 current=prepareAgentCliPlan({action:'status',provider:'codex',binding,operationId,expectedIntentDigest:install.agentCli.intentDigest});const status=await executeAgentCli(registry,current,verify);assert.equal(status.data.agentCli.state,'failed');assert.equal(status.data.agentCli.error,'INSTALL_FAILED');
 for(const provider of ['codex','claude']){current=plan('login-status',provider);const login=await executeAgentCli(registry,current,verify);assert.deepEqual(login.data.agentCli,{contract:'agent-cli-login-status-v1',provider,state:'not_installed'});}
 for(const mode of ['short','wrong']){fault=mode;current=plan();await assert.rejects(()=>executeAgentCli(registry,current,verify),unknown);}
 assert.equal(received.length,6);assert.ok(received.every(item=>item.bytes===item.expectedBytes&&item.sha256===item.expectedSha256));assert.deepEqual(await readFile(auth),authBytes);assert.equal(fixtureError,undefined);
});

async function retryWire(t){
 const hostKey=key(),clients=new Set(),received=[];let attempts=0,rejected=false,reached,release,passed=false;
 const retry=new Promise(resolve=>{reached=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 const server=new ssh2.Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client));client.on('authentication',request=>request.accept());
  client.on('ready',()=>client.on('session',(accept,reject)=>{attempts++;if(!rejected){rejected=true;reject();return;}const session=accept();session.on('env',accept=>accept?.());session.on('exec',(accept,_reject,info)=>{const stream=accept(),chunks=[];stream.on('error',()=>{});stream.on('data',chunk=>chunks.push(Buffer.from(chunk)));stream.once('end',()=>{received.push({command:info.command,source:Buffer.concat(chunks).toString('utf8')});stream.write(JSON.stringify(inspection('codex')));stream.exit(0);stream.end();});});}));
 });
 let connection;t.after(async()=>{release();await connection?.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const profile={name:binding.profile,host:'127.0.0.1',port:server.address().port,user:'synthetic',auth:'key',trustedHostKey:fingerprint(hostKey),readOnly:false,tty:false,announceAgent:false,timeout:8000,maxOutputBytes:65536};
 connection=new SSHConnection(profile,{privateKey:key()},new Map(),'strict');const ensure=connection.ensureConnected.bind(connection);connection.ensureConnected=async()=>{if(rejected&&!passed){reached();await barrier;passed=true;}return ensure();};
 return {profile,retry,release,received,get attempts(){return attempts;},registry:{getProfile:()=>profile,async getOrCreate(){await connection.ensureConnected();return connection;}}};
}
test('CLI-LOOPBACK real channel retry rechecks policy/target/profile and never replays admitted bytes',{timeout:30000},async t=>{
 for(const mode of ['policy','target','profile','unchanged'])await t.test(mode,async t=>{
  const wire=await retryWire(t),p=plan();let allowed=true,currentRevision=binding.targetRevision;
  const checked=()=>{if(!allowed)throw Error('Current policy denied');return {...binding,targetRevision:currentRevision};};
  const done=executeAgentCli(wire.registry,p,checked).then(result=>({result}),error=>({error}));await wire.retry;assert.equal(wire.attempts,1);assert.equal(wire.received.length,0);
  if(mode==='policy')allowed=false;if(mode==='target')currentRevision='e'.repeat(64);if(mode==='profile')wire.profile.user='changed';wire.release();
  const outcome=await done;
  if(mode==='unchanged'){assert.equal(outcome.result.failed,false);assert.equal(wire.attempts,2);assert.equal(wire.received.length,1);assert.equal(wire.received[0].source,p.stdin);assert.equal(wire.received[0].command,p.command);}
  else{assert.ok(outcome.error);assert.equal(wire.attempts,1);assert.equal(wire.received.length,0);}
 });
});

test('CLI-LOGIN delivery accepts only the fixed helper and discards vendor private fields',async()=>{
 for(const provider of ['codex','claude']){
  const p=plan('login-status',provider),f=fake(p);assert.deepEqual(JSON.parse(p.manifest.argvJson),[provider]);assert.ok(p.manifest.sourceBytes<=16384);
  for(const state of ['signed_in','signed_out','not_installed','unavailable']){
   f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify({provider,state,token:'SYNTHETIC_PRIVATE',email:'SYNTHETIC_PRIVATE'}),stderr:''});
   const r=await executeAgentCli(f.registry,p,verify);assert.deepEqual(r.data.agentCli,{contract:'agent-cli-login-status-v1',provider,state});assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
  }
  for(const change of [{provider:'other',state:'signed_in'},{provider,state:'completed'}]){f.connection.exec=async()=>({exitCode:0,stdout:JSON.stringify(change),stderr:''});await assert.rejects(()=>executeAgentCli(f.registry,p,verify));}
  for(const changed of [{...p,stdin:p.stdin+'# changed'},{...p,agentCli:{...p.agentCli,provider:'other'}},{...p,manifest:{...p.manifest,argvJson:JSON.stringify([provider,'login'])}}]){const g=fake(p);await assert.rejects(()=>executeAgentCli(g.registry,changed,verify));assert.equal(g.acquisitions,0);}
 }
});
