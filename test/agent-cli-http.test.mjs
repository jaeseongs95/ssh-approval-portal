import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access,writeFile,symlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../app.mjs';
import {classifyCommand} from 'ssh-mcp/build/policy/classifier.js';
import {validateAgentRelease,AGENT_CLI_CONTRACT} from '../src/domain/agent-cli.mjs';
import {createAgentCliState} from '../src/adapters/storage/agent-cli-state.mjs';

const adminOrigin='https://owner.test';
const defer=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:(...args)=>resolve(...args)};};
function release(provider){const name=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';return validateAgentRelease(provider,{name,version:'1.2.3',dist:{tarball:'https://registry.npmjs.org/'+name+'/-/'+name.split('/')[1]+'-1.2.3.tgz',integrity:'sha512-'+Buffer.alloc(64,7).toString('base64')}});}
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'cli-app-')),events=[],calls=[],profiles=new Map(),flags={probe:null,install:null,status:null,login:null,auditFail:false};
 let app,origin;const cleanup=[];t.after(async()=>{for(const release of cleanup)release();await app?.close();assert.ok(root.startsWith(join(tmpdir(),'cli-app-')));await rm(root,{recursive:true,force:true});});
 const env={BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:adminOrigin,BRIDGE_JEV_ENABLED:'false',BRIDGE_COMMAND_AUTOMATION:'false',...options.env};
 const execute=async(plan,verify)=>{
  const checked=verify();assert.equal(checked.targetId,plan.manifest.targetId);assert.equal(checked.targetRevision,plan.manifest.targetRevision);assert.equal(checked.profile,plan.manifest.profile);calls.push(plan);
  if(plan.agentCli.action==='login-status'){
   if(flags.probe)await flags.probe(plan,verify);
   return {failed:false,texts:[],data:{agentCli:{provider:plan.agentCli.provider,state:flags.login??'signed_in',private:'SYNTHETIC_PRIVATE'}}};
  }
  if(plan.agentCli.action==='inspect'){
   if(flags.probe)await flags.probe(plan,verify);
   return {failed:false,texts:[],data:{agentCli:{provider:plan.agentCli.provider,installed:false,managed:false,version:null,active:null,installationRevision:'b'.repeat(64),login:'not_checked',private:'SYNTHETIC_PRIVATE'}}};
  }
  if(plan.agentCli.action==='status')return {failed:false,texts:[],data:{agentCli:{provider:plan.agentCli.provider,operationId:plan.agentCli.operationId,state:flags.status??'completed',version:'1.2.3',login:'not_checked',private:'SYNTHETIC_PRIVATE'}}};
  if(flags.install)await flags.install(plan,verify);
  return {failed:false,texts:[],data:{agentCli:{contract:AGENT_CLI_CONTRACT,provider:plan.agentCli.provider,state:'completed',operationId:plan.agentCli.operationId,version:'1.2.3',login:'not_checked'}}};
 };
 const registry={getProfile:name=>{if(!profiles.has(name))profiles.set(name,{host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'});return profiles.get(name);},closeAll:async()=>{events.push({action:'fixture-connections-closed'});}};
 const make=()=>createApplication({registry,classify:classifyCommand,executeCommand:async()=>({failed:false,texts:['legacy']}),executePythonSource:async()=>({failed:false,texts:['source']}),executeAgentCli:execute,agentReleaseCatalog:{get:async provider=>({release:release(provider),expiresAt:Date.now()+300000})},audit:event=>{if(flags.auditFail&&event.action==='cli-probe-started')throw Error('SYNTHETIC_PRIVATE');events.push(event);},transferRoot:root,uiHtml:'<html></html>',...options,env});
 app=await make();
 const listen=async()=>{await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+app.adminHttp.address().port;};await listen();
 const api=async(path,{method='GET',body,token='fixture-owner',originHeader=adminOrigin,contentType='application/json',raw,signal}={})=>{
  const response=await fetch(origin+path,{method,signal,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(originHeader===null?{}:{Origin:originHeader}),'Content-Type':contentType},...(body===undefined&&raw===undefined?{}:{body:raw??JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),headers:response.headers};
 };
 const preview=async(provider='codex',targetId='default')=>{const response=await api('/api/agent-cli/preview',{method:'POST',body:{targetId,provider}});assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
 const request=(p,key='cli-request-00000001')=>({planId:p.planId,request:{targetId:p.binding.targetId,targetRevision:p.binding.targetRevision,profile:p.binding.profile,provider:p.release.provider,action:'install',releaseDigest:p.release.releaseDigest,expectedInstallationRevision:p.installation.installationRevision,requestKey:key}});
 const submit=async(p,key)=>{const response=await api('/api/agent-cli/submit',{method:'POST',body:request(p,key)});assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
 const start=job=>api('/api/agent-cli/start',{method:'POST',body:{requestId:job.id}});
 return {root,events,calls,profiles,flags,env,api,preview,request,submit,start,beforeClose(fn){cleanup.push(fn);},get app(){return app;},async restart(){await app.close();app=await make();await listen();}};
}

test('CLI-HTTP capability is owner-only and executes no SSH; Jev/automation off stays off',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.env);const response=await f.api('/api/agent-cli');assert.equal(response.status,200);assert.equal(response.body.available,true);assert.deepEqual(response.body.providers.map(p=>p.id),['codex','claude']);assert.equal(f.calls.length,0);
 for(const token of [null,'fixture-mcp','wrong'])assert.equal((await f.api('/api/agent-cli',{token})).status,401);
 assert.equal((await f.api('/api/command-policy')).status,404);assert.equal(JSON.stringify(f.env),before);assert.equal(await access(join(f.root,'command-automation.sqlite')).then(()=>true,()=>false),false);
});
test('CLI-HTTP missing runtime reports unavailable without a private CLI journal',async t=>{
 const f=await fixture(t,{executeAgentCli:undefined});assert.equal((await f.api('/api/agent-cli')).body.available,false);assert.equal((await f.api('/api/agent-cli/preview',{method:'POST',body:{targetId:'default',provider:'codex'}})).status,409);assert.equal(await access(join(f.root,'agent-cli.sqlite')).then(()=>true,()=>false),false);
});
test('CLI-HTTP lookup restores only a scoped owner record with GET and never probes or executes',async t=>{
 const f=await fixture(t),key='restore-request-000001',p=await f.preview(),job=await f.submit(p,key);
 const query='/api/agent-cli/lookup?'+new URLSearchParams({key,targetId:'default',provider:'codex'}),before=f.calls.length;
 const found=await f.api(query,{originHeader:null});assert.equal(found.status,200);assert.equal(found.body.found,true);assert.equal(found.body.job.id,job.id);assert.equal(found.body.job.state,'pending');assert.ok(!JSON.stringify(found.body).includes('SYNTHETIC_PRIVATE'));
 for(const token of [null,'fixture-mcp','wrong'])assert.equal((await f.api(query,{token,originHeader:null})).status,401);
 for(const suffix of ['&key=another-request-0001','&unexpected=1','&provider=claude'])assert.equal((await f.api(query+suffix)).status,409);
 assert.equal((await f.api(query.replace('provider=codex','provider=claude'))).status,409);
 assert.equal((await f.api(query.replace('targetId=default','targetId=unregistered'))).status,409);
 assert.equal((await f.api(query.replace(key,'missing-request-00001'))).body.found,false);
 assert.equal(f.calls.length,before);await f.restart();assert.equal((await f.api(query)).body.job.state,'expired');assert.equal(f.calls.length,before);
 f.profiles.get('aws-local').user='changed';assert.equal((await f.api(query)).status,409);assert.equal(f.calls.length,before);
});
test('CLI-HISTORY owner can find existing scoped requests without a browser key and no probe or journal write',async t=>{
 const f=await fixture(t),codex=await f.submit(await f.preview(),'history-codex-request-001'),claude=await f.submit(await f.preview('claude'),'history-claude-request-001');
 const beforeCalls=f.calls.length,beforeDb=await readFile(join(f.root,'agent-cli.sqlite')),beforeJobs=JSON.stringify(f.app.targets.queue.listAll());
 const query='/api/agent-cli/history?targetId=default&provider=codex',value=await f.api(query,{originHeader:null});
 assert.equal(value.status,200,'owner history lookup must not require a browser request key');
 assert.deepEqual(value.body.requests,[{id:codex.id,state:'pending',createdAt:codex.createdAt}]);assert.equal(value.body.next,null);assert.equal(value.body.provider,'codex');assert.equal(value.body.binding.targetId,'default');assert.equal(value.body.binding.profile,'aws-local');
 assert.equal((await f.api(query.replace('provider=codex','provider=claude'))).body.requests[0].id,claude.id);
 assert.doesNotMatch(JSON.stringify(value.body),/SYNTHETIC_PRIVATE|sourceSha256|sourceArgvJson|request_key|command/);
 assert.equal(f.calls.length,beforeCalls);assert.equal(JSON.stringify(f.app.targets.queue.listAll()),beforeJobs);assert.deepEqual(await readFile(join(f.root,'agent-cli.sqlite')),beforeDb);
});
test('CLI-HISTORY preserves owner/current-binding and exact query boundaries',async t=>{
 const f=await fixture(t);await f.submit(await f.preview(),'history-owner-request-001');const before=f.calls.length,query='/api/agent-cli/history?targetId=default&provider=codex';
 assert.equal((await f.api(query)).status,200);
 for(const token of [null,'fixture-mcp','wrong'])assert.equal((await f.api(query,{token})).status,401);
 assert.equal((await f.api(query,{originHeader:'https://attacker.test'})).status,403);
 for(const suffix of ['&unexpected=1','&provider=claude','&before=1000','&beforeId='+ 'a'.repeat(48),'&before=NaN&beforeId='+'a'.repeat(48),'&before=1000&beforeId=bad'])assert.equal((await f.api(query+suffix)).status,409);
 for(const bad of [query.replace('provider=codex','provider=other'),query.replace('targetId=default','targetId=unknown')])assert.equal((await f.api(bad)).status,409);
 f.profiles.get('aws-local').user='changed';assert.equal((await f.api(query)).status,409);assert.equal(f.calls.length,before);
});
test('CLI-HISTORY survived restart exposes the same expired request without recreating execution authority',async t=>{
 const f=await fixture(t),job=await f.submit(await f.preview(),'history-restart-request-001'),before=f.calls.length;await f.restart();
 const value=await f.api('/api/agent-cli/history?targetId=default&provider=codex');assert.equal(value.status,200);assert.deepEqual(value.body.requests,[{id:job.id,state:'expired',createdAt:job.createdAt}]);
 const found=await f.api('/api/agent-cli/requests/'+job.id);assert.equal(found.body.job.id,job.id);assert.equal(found.body.job.state,'expired');assert.equal((await f.start(found.body.job)).body.state,'expired');assert.equal(f.calls.length,before);
});
test('CLI-HTTP every mutation requires owner, exact Origin and bounded JSON before probe',async t=>{
 const f=await fixture(t),body={targetId:'default',provider:'codex'};
 for(const path of ['preview','submit','start','reconcile','login-status']){
  for(const token of [null,'fixture-mcp'])assert.equal((await f.api('/api/agent-cli/'+path,{method:'POST',body,token})).status,401);
  for(const originHeader of [null,'https://attacker.test'])assert.equal((await f.api('/api/agent-cli/'+path,{method:'POST',body,originHeader})).status,403);
 }
 assert.equal((await f.api('/api/agent-cli/preview',{method:'POST',body,contentType:'text/plain'})).status,415);
 assert.equal((await f.api('/api/agent-cli/preview',{method:'POST',raw:Buffer.from([0xff])})).status,400);
 assert.equal((await f.api('/api/agent-cli/preview',{method:'POST',raw:JSON.stringify({...body,extra:'x'.repeat(8193)})})).status,413);
 assert.equal((await f.api('/api/agent-cli/preview?target=default',{method:'POST',body})).status,409);assert.equal(f.calls.length,0);
});
test('CLI-HTTP real app preview/pending/start/output flow executes only after owner and returns running promptly',async t=>{
 const f=await fixture(t),p=await f.preview();assert.equal(f.calls.length,1);assert.equal(f.calls[0].agentCli.action,'inspect');assert.ok(!JSON.stringify(p).includes('SYNTHETIC_PRIVATE'));
 const job=await f.submit(p);assert.equal(job.state,'pending');assert.equal(f.calls.length,1);assert.equal((await f.api('/api/'+job.id+'/source')).status,200);
 for(const token of [null,'fixture-mcp'])assert.equal((await f.api('/api/agent-cli/requests/'+job.id,{token})).status,401);
 const gate=defer(),entered=defer();f.beforeClose(gate.resolve);f.flags.install=async()=>{entered.resolve();await gate.promise;};
 const started=await f.start(job);assert.equal(started.status,200);assert.equal(started.body.state,'running');await entered.promise;
 assert.equal((await f.start(job)).body.id,job.id);assert.equal(f.calls.filter(p=>p.agentCli.action==='install').length,1);
 assert.equal((await f.api('/api/agent-cli/requests/'+job.id)).body.job.state,'running');assert.equal((await f.api('/api/maintenance/reserve',{method:'POST',body:{}})).status,409);
 gate.resolve();await f.app.targets.drain();const complete=(await f.api('/api/agent-cli/requests/'+job.id)).body.job;assert.equal(complete.state,'completed');assert.equal(complete.approvalMode,'owner');
 const output=await f.api('/api/outputs/'+complete.result.structuredContent.output.id+'?format=json');assert.equal(output.status,200);assert.equal(JSON.parse(output.body.text).data.agentCli.login,'not_checked');assert.equal(f.events.some(event=>event.action==='approved'&&event.approvalMode==='owner'),true);
 assert.equal((await f.api('/api/'+job.id+'/source')).status,409);assert.equal((await f.api('/api/agent-cli/submit',{method:'POST',body:f.request(p)})).body.id,job.id);
});
test('CLI-HTTP changing preview target/profile/fields/key payload cannot create a replacement request',async t=>{
 const f=await fixture(t),p=await f.preview(),body=f.request(p);
 for(const bad of [{...body,command:'id'},{...body,request:{...body.request,profile:'other'}},{...body,request:{...body.request,package:'arbitrary'}},{...body,planId:'c'.repeat(48)}])assert.equal((await f.api('/api/agent-cli/submit',{method:'POST',body:bad})).status,409);
 const job=await f.submit(p);assert.equal((await f.api('/api/agent-cli/submit',{method:'POST',body:{...body,request:{...body.request,action:'update'}}})).status,409);assert.equal((await f.api('/api/agent-cli/start',{method:'POST',body:{requestId:job.id,command:'id'}})).status,409);assert.equal(f.calls.length,1);
});
test('CLI-HTTP target drift at actual start blocks the same persisted job',async t=>{
 const f=await fixture(t),job=await f.submit(await f.preview());f.profiles.get('aws-local').user='changed';assert.equal((await f.start(job)).status,409);assert.equal(f.calls.length,1);
});
test('CLI-HTTP a pending request expires after app restart and private source/installation authority are never restored',async t=>{
 const f=await fixture(t),job=await f.submit(await f.preview());await f.restart();
 const restored=(await f.api('/api/agent-cli/requests/'+job.id)).body.job;assert.equal(restored.state,'expired');assert.equal((await f.start(restored)).body.state,'expired');assert.equal((await f.api('/api/'+job.id+'/source')).status,409);assert.equal(f.calls.length,1);
});
test('CLI-HTTP unknown transport persists across restart; readonly reconcile does not replay installation or rewrite its audit state',async t=>{
 const f=await fixture(t),job=await f.submit(await f.preview());f.flags.install=async()=>{throw Error('SYNTHETIC_PRIVATE');};await f.start(job);await f.app.targets.drain();assert.equal((await f.api('/api/agent-cli/requests/'+job.id)).body.job.state,'unknown');
 await f.restart();assert.equal((await f.start(job)).body.state,'unknown');assert.equal(f.calls.filter(p=>p.agentCli.action==='install').length,1);
 const response=await f.api('/api/agent-cli/reconcile',{method:'POST',body:{requestId:job.id}});assert.equal(response.status,200);assert.equal(response.body.remoteStatus.state,'completed');assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_PRIVATE'));
 assert.equal(f.calls.at(-1).agentCli.action,'status');assert.equal(f.calls.at(-1).agentCli.operationId,job.operation.agentCliOperationId);
 await f.restart();const saved=(await f.api('/api/agent-cli/requests/'+job.id)).body;assert.equal(saved.job.state,'unknown');assert.equal(saved.remoteStatus.state,'completed');assert.equal(f.calls.filter(p=>p.agentCli.action==='install').length,1);
});
test('CLI-HTTP probe claim blocks maintenance and shutdown drains it before closing connections',async t=>{
 const f=await fixture(t),gate=defer(),entered=defer(),abort=new AbortController();f.beforeClose(gate.resolve);f.flags.probe=async()=>{entered.resolve();await gate.promise;};const preview=f.api('/api/agent-cli/preview',{method:'POST',body:{targetId:'default',provider:'codex'},signal:abort.signal}).then(()=>false,error=>error.name==='AbortError');await entered.promise;
 assert.equal((await f.api('/api/maintenance/reserve',{method:'POST',body:{}})).status,409);
 abort.abort();assert.equal(await preview,true);const httpClosed=new Promise(resolve=>f.app.adminHttp.once('close',resolve));
 let closed=false;const closing=f.app.close().then(()=>{closed=true;});await httpClosed;await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.equal(f.events.some(event=>event.action==='fixture-connections-closed'),false);gate.resolve();await closing;assert.equal(closed,true);assert.equal(f.events.at(-1).action,'fixture-connections-closed');
});
test('CLI-HTTP probe audit failure prevents remote work and releases its global claim',async t=>{
 const f=await fixture(t);f.flags.auditFail=true;const response=await f.api('/api/agent-cli/preview',{method:'POST',body:{targetId:'default',provider:'codex'}});assert.equal(response.status,409);assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_PRIVATE'));assert.equal(f.calls.length,0);f.flags.auditFail=false;assert.ok(await f.preview());
});
test('CLI-HTTP stored deny policy applies to fixed helper and stays byte-identical during rejected CLI requests',async t=>{
 const f=await fixture(t,{env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:adminOrigin,BRIDGE_COMMAND_AUTOMATION:'true',BRIDGE_JEV_ENABLED:'false'}});
 const current=(await f.api('/api/command-policy')).body,binding=current.bindings[0];
 const policy={targets:[{targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,commands:[],deniedCommands:['npm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]};
 const proposal={policy,expectedRevision:current.revision},review=await f.api('/api/command-policy/review',{method:'POST',body:proposal});assert.equal(review.status,200);assert.equal((await f.api('/api/command-policy',{method:'POST',body:{...proposal,reviewToken:review.body.reviewToken,acknowledged:true}})).status,200);
 const before=await readFile(join(f.root,'command-automation.sqlite'));assert.equal((await f.api('/api/agent-cli/preview',{method:'POST',body:{targetId:'default',provider:'codex'}})).status,409);assert.equal(f.calls.length,0);assert.deepEqual(await readFile(join(f.root,'command-automation.sqlite')),before);
});
test('CLI-HTTP adding deny policy after pending admission blocks start without touching that policy',async t=>{
 const f=await fixture(t,{env:{BRIDGE_COMMAND_AUTOMATION:'true'}}),job=await f.submit(await f.preview());const current=(await f.api('/api/command-policy')).body,binding=current.bindings[0];
 const proposal={expectedRevision:current.revision,policy:{targets:[{targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,commands:[],deniedCommands:['npm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}]}};
 const review=await f.api('/api/command-policy/review',{method:'POST',body:proposal});assert.equal(review.status,200);assert.equal((await f.api('/api/command-policy',{method:'POST',body:{...proposal,reviewToken:review.body.reviewToken,acknowledged:true}})).status,200);
 const before=await readFile(join(f.root,'command-automation.sqlite'));assert.equal((await f.start(job)).status,409);assert.equal(f.calls.filter(p=>p.agentCli.action==='install').length,0);assert.deepEqual(await readFile(join(f.root,'command-automation.sqlite')),before);
});
test('CLI-HTTP explicit targets and the global request key cannot cross-bind CLI work',async t=>{
 const profiles=new Map(),entries=['alpha','beta'].map(id=>({id,displayName:id,readProfile:id+'-read',writeProfile:id+'-write',credentialRevision:'v1'}));
 for(const entry of entries)for(const name of [entry.readProfile,entry.writeProfile])profiles.set(name,{name,host:entry.id+'.example',port:22,user:'fixture',readOnly:name===entry.readProfile,trustedHostKey:'synthetic-'+entry.id});
 const f=await fixture(t,{env:{BRIDGE_TARGETS:JSON.stringify(entries),BRIDGE_DEFAULT_TARGET:'alpha'},registry:{getProfile:name=>profiles.get(name),closeAll:async()=>{}}});
 const alpha=await f.preview('codex','alpha'),beta=await f.preview('codex','beta'),job=await f.submit(alpha);
 const cross={...f.request(alpha),request:{...f.request(alpha).request,targetId:'beta',profile:beta.binding.profile,targetRevision:beta.binding.targetRevision}};
 assert.equal((await f.api('/api/agent-cli/submit',{method:'POST',body:cross})).status,409);assert.equal((await f.api('/api/agent-cli/submit',{method:'POST',body:f.request(beta)})).status,409);
 await f.start(job);await f.app.targets.drain();assert.deepEqual(f.calls.filter(p=>p.agentCli.action==='install').map(p=>p.manifest.targetId),['alpha']);
});
test('CLI-JOURNAL pending/running normalization, conflict and remote public projection use the dedicated private file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cli-journal-'));let journal=createAgentCliState(root);t.after(async()=>{journal.close();await rm(root,{recursive:true,force:true});});
 const job={id:'a'.repeat(48),kind:'command',state:'pending',operation:{agentCliContract:AGENT_CLI_CONTRACT,agentCliProvider:'codex',agentCliOperationId:'b'.repeat(48)}};
 journal.insert(job,'agent-cli:journal-key-0001','c'.repeat(64));assert.throws(()=>journal.insert(job,'agent-cli:journal-key-0001','c'.repeat(64)));journal.save({...job,state:'running'});journal.close();journal=createAgentCliState(root);assert.equal(journal.get(job.id).job.state,'unknown');
 const status=journal.recordRemote(job.id,{provider:'codex',operationId:'b'.repeat(48),state:'failed',version:'1.2.3',login:'not_checked',error:'SYNTHETIC_PRIVATE',private:'SYNTHETIC_PRIVATE'});assert.equal(status.error,'INSTALL_FAILED');assert.ok(!JSON.stringify(journal.get(job.id)).includes('SYNTHETIC_PRIVATE'));
 assert.throws(()=>journal.recordRemote(job.id,{...status,operationId:'d'.repeat(48)}));
});
test('CLI-JOURNAL refuses a foreign symlink or permissive existing database',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cli-journal-path-'));t.after(()=>rm(root,{recursive:true,force:true}));const foreign=join(root,'foreign');await writeFile(foreign,'preserve',{mode:0o600});await symlink(foreign,join(root,'agent-cli.sqlite'));assert.throws(()=>createAgentCliState(root));assert.equal(await readFile(foreign,'utf8'),'preserve');
 await rm(join(root,'agent-cli.sqlite'));let journal=createAgentCliState(root);journal.close();await chmod(join(root,'agent-cli.sqlite'),0o644);if(process.platform!=='win32')assert.throws(()=>createAgentCliState(root));
});
test('CLI-ACK reconciliation observes remote records without completing or replaying an unknown request',async t=>{
 const f=await fixture(t),job=await f.submit(await f.preview());
 f.flags.install=async()=>{throw Error('SYNTHETIC_DIRECTORY_ACK_FAILED');};await f.start(job);await f.app.targets.drain();
 const before=JSON.stringify(f.env);
 for(const state of ['completed','failed','unknown','reused']){
  f.flags.status=state;
  const response=await f.api('/api/agent-cli/reconcile',{method:'POST',body:{requestId:job.id}});
  assert.equal(response.status,200);assert.equal(response.body.remoteStatus.state,state);
  assert.equal((await f.api('/api/agent-cli/requests/'+job.id)).body.job.state,'unknown');assert.ok(!JSON.stringify(response.body).includes('SYNTHETIC_'));
  await f.restart();const saved=(await f.api('/api/agent-cli/requests/'+job.id)).body;
  assert.equal(saved.job.state,'unknown');assert.equal(saved.remoteStatus.state,state);
  assert.equal((await f.start(job)).body.state,'unknown');
  assert.equal(f.calls.filter(p=>p.agentCli.action==='install').length,1);
 }
 assert.equal(JSON.stringify(f.env),before);
});

// Status checks share the real owner HTTP and target-execution composition.
test('CLI-LOGIN owner projection covers both providers and four honest states',async t=>{
 const f=await fixture(t),path='/api/agent-cli/login-status';
 for(const provider of ['codex','claude'])for(const state of ['signed_in','signed_out','not_installed','unavailable']){
  f.flags.login=state;const r=await f.api(path,{method:'POST',body:{targetId:'default',provider}});
  assert.equal(r.status,200);assert.equal(r.body.provider,provider);assert.equal(r.body.state,state);assert.ok(Number.isSafeInteger(r.body.checkedAt));
  assert.deepEqual(Object.keys(r.body).sort(),['binding','checkedAt','provider','state']);assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
 }
 const before=f.calls.length;
 for(const body of [{targetId:'default',provider:'other'},{targetId:'missing',provider:'codex'},{targetId:'default',provider:'codex',command:'id'}])assert.equal((await f.api(path,{method:'POST',body})).status,409);
 assert.equal(f.calls.length,before);assert.equal((await f.api(path,{method:'GET'})).status,403);
 assert.equal((await f.api(path,{method:'POST',body:{},contentType:'text/plain'})).status,415);
 assert.equal((await f.api(path+'?extra=1',{method:'POST',body:{}})).status,409);
 assert.equal(f.app.queue.listAll().length,0);
});
test('CLI-LOGIN probe claim rejects concurrent work, hides errors and rejects binding drift',async t=>{
 const f=await fixture(t),body={targetId:'default',provider:'codex'},path='/api/agent-cli/login-status';
 const entered=defer(),gate=defer();f.beforeClose(gate.resolve);f.flags.probe=async()=>{entered.resolve();await gate.promise;};
 const pending=f.api(path,{method:'POST',body});await Promise.race([entered.promise,pending.then(r=>{assert.equal(r.status,200);})]);
 assert.equal((await f.api(path,{method:'POST',body})).status,409);
 assert.equal((await f.api('/api/maintenance/reserve',{method:'POST',body:{}})).status,409);
 f.profiles.get('aws-local').user='changed';gate.resolve();assert.equal((await pending).status,409);
 f.profiles.get('aws-local').user='fixture';f.flags.probe=async()=>{throw Error('SYNTHETIC_PRIVATE');};
 const r=await f.api(path,{method:'POST',body});assert.equal(r.body.state,'unavailable');assert.ok(!JSON.stringify(r).includes('SYNTHETIC_PRIVATE'));
 f.flags.probe=null;assert.equal((await f.api(path,{method:'POST',body})).body.state,'signed_in');
 assert.equal(f.events.filter(e=>e.action==='cli-probe-started').length,f.events.filter(e=>e.action==='cli-probe-finished').length);
});
