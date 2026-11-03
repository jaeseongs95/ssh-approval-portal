import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApplication} from '../app.mjs';

// engineering-test-plan: native MCP + owner HTTP integration with fake SSH executors.
// legacy-17/multi-target.test.mjs.17 case 1 -> native routing/observe + owner HTTP below;
// case 2 -> retained private owner-ticket test plus native artifact test; case 3 -> durable
// queued/serialization/drain test (legacy synchronous busy refusal deliberately removed);
// cases 4/5 -> retained quota/maintenance and revised target-revision/download tests.
// Fixed target/profile identities, bytes/hash, peak=2 and target concurrency=1 are the oracles.
// Local product execution is excluded; root runs these cases on the remote test host.
const data=reply=>{assert.equal(reply.isError,undefined,JSON.stringify(reply));assert.equal(reply.structuredContent.ok,true);return reply.structuredContent.data;};
let keySequence=0;
const submit=(f,command,target)=>f.call('submit',{kind:'command',command,...(target?{target}:{}),operationKey:`multi-target-operation-${++keySequence}`}).then(data);
async function observe(f,id,includeOutput=false){const end=Date.now()+3000;for(;;){const value=data(await f.call('observe',{id,includeOutput,waitMs:10}));if(['completed','failed','denied','cancelled','unknown','expired'].includes(value.state))return value;if(Date.now()>end)throw Error('Operation fixture deadline exceeded');}}

const bytes=Buffer.from([0,255,13,10]),sha256=createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(condition) {const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw Error('Fixture deadline exceeded');await settle();}}
async function fixture(options={}) {
  const root=await mkdtemp(join(tmpdir(),'ssh-multi-')),calls=[],events=[];
  const entries=['alpha','beta','gamma','offline'].map(id=>({id,displayName:`이름 ${id}`,readProfile:`${id}-read`,writeProfile:`${id}-write`,credentialRevision:options.credentialRevision??'v1',enabled:id!=='offline'}));
  const profiles=new Map(entries.flatMap(entry=>[entry.readProfile,entry.writeProfile].map(name=>[name,{name,host:`${entry.id}.example.test`,port:22,user:'synthetic',readOnly:name.endsWith('-read'),trustedHostKey:'SHA256:'+entry.id}])));
  const env={BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-admin',BRIDGE_ADMIN_ORIGIN:'https://admin.example.test',BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_UI_ENABLED:'true',BRIDGE_TARGETS:JSON.stringify(entries),BRIDGE_TRANSFER_MAX_BYTES:'64',BRIDGE_TRANSFER_BUDGET_BYTES:'128',...(options.requestCapacity?{BRIDGE_REQUEST_CAPACITY:options.requestCapacity}:{}),...(options.noDefault?{}:{BRIDGE_DEFAULT_TARGET:'alpha'})};
  let closed=false;
  const app=await createApplication({registry:{getProfile:name=>profiles.get(name),closeAll:async()=>{closed=true;}},classify:command=>({class:command==='id'?'read-only':'privileged'}),
    executeCommand:async(profile,command)=>{calls.push({profile,command});return options.execute?options.execute(profile,command):{failed:false,texts:[profile]};},audit:event=>{if(options.auditFails?.(event))throw Error('synthetic audit failure');events.push(event);},transferRoot:root,env,uiHtml:'<html>fixture</html>',uploadSource:options.source});
  await new Promise(resolve=>app.mcpHttp.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
  const web=`http://127.0.0.1:${app.adminHttp.address().port}`;
  const client=new Client({name:'multi-fixture',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.mcpHttp.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer fixture-mcp'}}}));
  return {root,app,client,calls,events,profiles,web,get closed(){return closed;},call:(name,args={})=>client.callTool({name,arguments:args}),
    http:(path,method='GET')=>fetch(web+path,{method,headers:{Authorization:'Bearer fixture-admin',Origin:'https://admin.example.test','X-Maintenance-Owner':'a'.repeat(64)}}),
    async close(){await client.close();await app.close();await rm(root,{recursive:true});}};
}
const transfer=target=>({target,direction:'upload',remotePath:'/tmp/same.bin',elevate:false,overwrite:false});
async function begin(f,target) {const seed=await f.call('show-file-transfer',transfer(target));const result=await f.call('ui-upload-begin',{transfer:seed.structuredContent.transfer,ticket:seed._meta.sshApproval.bootstrapTicket,fileName:'same.bin',size:bytes.length,sha256});return {seed,id:result.structuredContent.transferId,ticket:result._meta.sshApproval.uploadTicket};}

test('MCP target routing, explicit/default refusal and owner-only HTTP filtering preserve fixed identities',async()=>{
 const f=await fixture();try {
  const targets=data(await f.call('targets'));assert.equal(targets.defaultTarget,'alpha');assert.equal(targets.targets.length,4);
  assert.ok(!JSON.stringify(targets).includes('readProfile'));assert.ok(!JSON.stringify(targets).includes('SHA256'));
  for(const target of ['unknown','offline','127.0.0.1','__proto__']) assert.equal((await f.call('submit',{kind:'command',command:'sudo id',target,operationKey:`invalid-target-key-${++keySequence}`})).isError,true);
  const read=await submit(f,'id','beta');assert.equal(read.targetId,'beta');assert.equal((await observe(f,read.id,true)).outputPage.text,'beta-read');
  const a=await submit(f,'sudo same'),b=await submit(f,'sudo same','beta');
  assert.equal(a.targetId,'alpha');assert.equal(b.targetId,'beta');assert.equal(a.targetRevision,targets.targets.find(target=>target.id==='alpha').revision);
  assert.equal((await fetch(f.web+'/api/targets')).status,401);
  const list=await(await f.http('/api/requests?target=beta')).json();assert.deepEqual(list.map(x=>x.id),[read.id,b.id]);assert.ok(list.every(job=>job.targetId==='beta'));
  assert.equal((await f.http('/api/requests?target=unknown')).status,409);
  assert.equal((await f.http(`/api/${a.id}/approve?target=beta`,'POST')).status,409);assert.equal(f.calls.length,1);
  const cardA=await f.call('show-approval',{id:a.id}),cardB=await f.call('show-approval',{id:b.id});
  assert.equal(cardB._meta.sshApproval.targetDisplayName,'이름 beta');
  assert.equal((await f.call('ui-decide-request',{id:b.id,action:'approve',ticket:cardA._meta.sshApproval.approvalTicket})).isError,true);
  const decisions=await Promise.all([1,2].map(()=>f.call('ui-decide-request',{id:a.id,action:'approve',ticket:cardA._meta.sshApproval.approvalTicket})));
  assert.equal(decisions.filter(x=>x.isError).length,1);await f.app.queue.wait(a.id);assert.equal(f.calls.filter(x=>x.profile==='alpha-write').length,1);
  await f.http(`/api/${b.id}/approve`,'POST');assert.equal(f.calls.filter(x=>x.profile==='beta-write').length,1);
  assert.equal(data(await f.call('observe',{id:b.id})).targetId,'beta');
 }finally{await f.close();}
 const g=await fixture({noDefault:true});try {const refused=await g.call('submit',{kind:'command',command:'sudo id',operationKey:'missing-default-target-1'});assert.equal(refused.structuredContent.error.code,'TARGET_UNAVAILABLE');assert.equal(g.calls.length,0);assert.equal((await observe(g,(await submit(g,'id','beta')).id)).state,'completed');}finally{await g.close();}
});

test('file bootstrap, staged bytes, approval tickets and cleanup remain target-owned',async()=>{
 const f=await fixture();try {
  const a=await begin(f,'alpha'),b=await begin(f,'beta');
  assert.equal((await f.call('ui-upload-begin',{transfer:transfer('beta'),ticket:a.seed._meta.sshApproval.bootstrapTicket,fileName:'bad.bin',size:bytes.length,sha256})).isError,true);
  assert.equal((await f.call('ui-upload-chunk',{id:b.id,ticket:a.ticket,sequence:0,data:bytes.toString('base64')})).isError,true);
  assert.equal((await f.call('ui-upload-finish',{id:b.id,ticket:a.ticket})).isError,true);
  assert.throws(()=>f.app.targets.select('alpha').store.get(b.id));assert.throws(()=>f.app.targets.select('beta').store.remove(a.id));
  for(const [id,item]of [['alpha',a],['beta',b]]) {
   await f.call('ui-upload-chunk',{id:item.id,ticket:item.ticket,sequence:0,data:bytes.toString('base64')});
   const job=await f.call('ui-upload-finish',{id:item.id,ticket:item.ticket});assert.equal(job.structuredContent.targetId,id);
   const runtime=f.app.targets.select(id);runtime.transfers.upload=async op=>{const fd=await runtime.store.verified(op.artifactId);try{const chunks=[];for await(const chunk of fd.createReadStream({start:0,autoClose:false}))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);}finally{await fd.close();}f.calls.push({profile:id+'-upload',artifactId:op.artifactId});return {failed:false,texts:['uploaded']};};
   await f.call('ui-decide-request',{id:job.structuredContent.id,action:'approve',ticket:job._meta.sshApproval.approvalTicket});await f.app.queue.wait(job.structuredContent.id);
  }
  assert.deepEqual(f.calls.map(x=>x.artifactId),[a.id,b.id]);await f.app.store.reap();assert.equal(f.app.store.reserved,0);
  const retained=await readdir(f.root),stores=['maintenance.sqlite','operations.sqlite','capacity.sqlite'];
  assert.ok(retained.includes('command-outputs'));
  const allowed=new Set(['command-outputs']);
  for(const base of stores){
   assert.ok(retained.includes(base),base+' must be present');
   for(const name of [base,base+'-journal',base+'-wal',base+'-shm'].filter(name=>retained.includes(name))){
    const info=lstatSync(join(f.root,name));
    assert.equal(info.isFile(),true,name);assert.equal(info.isSymbolicLink(),false,name);assert.equal(info.nlink,1,name);
    if(process.platform!=='win32'){assert.equal(info.mode&0o077,0,name);assert.equal(info.uid,process.getuid(),name);}
    allowed.add(name);
   }
  }
  assert.deepEqual(retained.filter(name=>!allowed.has(name)),[],'only verified durable service stores and their observed SQLite sidecars remain after artifact cleanup');
  const reserve=target=>f.app.targets.files.beginUpload({target,fileName:'quota.bin',remotePath:'/tmp/quota.bin',size:64,sha256,overwrite:false,elevate:false});
  const first=await reserve('alpha'),second=await reserve('beta');assert.equal(f.app.store.reserved,128);
  await assert.rejects(reserve('gamma'));assert.equal(f.app.store.size,2);
  await f.app.targets.select('alpha').store.remove(first.id);const third=await reserve('gamma');
  await f.app.targets.select('beta').store.remove(second.id);await f.app.targets.select('gamma').store.remove(third.id);assert.equal(f.app.store.reserved,0);
 }finally{await f.close();}
});

test('native upload revision bindings keep staged bytes, submitted status and execution target-owned',async()=>{
 const f=await fixture();try {
  const targets=data(await f.call('targets')).targets,staged=[];
  const revisions=Object.fromEntries(targets.map(item=>[item.id,item.revision]));
  const wrong=await f.call('artifact-begin',{operationKey:'native-wrong-target-revision',target:'alpha',expectedTargetRevision:revisions.beta,fileName:'same.bin',size:bytes.length,sha256,remotePath:'/tmp/same.bin'});
  assert.equal(wrong.structuredContent.error.code,'ARTIFACT_STALE_TARGET');assert.equal(f.app.store.reserved,0);
  for(const target of ['alpha','beta']) {
   const item=data(await f.call('artifact-begin',{operationKey:`native-upload-target-${target}`,target,expectedTargetRevision:revisions[target],fileName:'same.bin',size:bytes.length,sha256,remotePath:'/tmp/same.bin'}));
   assert.equal(item.targetId,target);assert.equal(item.targetRevision,revisions[target]);staged.push(item);
   assert.equal(data(await f.call('artifact-status',{id:item.id})).state,'staging');
   data(await f.call('artifact-chunk',{id:item.id,sequence:0,data:bytes.toString('base64')}));
   const runtime=f.app.targets.select(target);runtime.transfers.upload=async operation=>{const fd=await runtime.store.verified(operation.artifactId);try{const chunks=[];for await(const chunk of fd.createReadStream({start:0,autoClose:false}))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);}finally{await fd.close();}f.calls.push({profile:target+'-upload',artifactId:operation.artifactId});return {failed:false,texts:['uploaded']};};
   const job=data(await f.call('artifact-finish',{id:item.id}));assert.equal(job.targetId,target);assert.equal(job.state,'pending');assert.equal(f.calls.length,staged.length-1);
   assert.equal(data(await f.call('artifact-finish',{id:item.id})).id,job.id);
   const status=data(await f.call('artifact-status',{id:item.id}));assert.equal(status.state,'submitted');assert.equal(status.request.id,job.id);
   await f.http(`/api/${job.id}/approve`,'POST');assert.equal((await observe(f,job.id)).state,'completed');
  }
  assert.throws(()=>f.app.targets.select('alpha').store.get(staged[1].id));assert.throws(()=>f.app.targets.select('beta').store.get(staged[0].id));
  assert.deepEqual(f.calls.map(call=>call.artifactId),staged.map(item=>item.id));await f.app.store.reap();assert.equal(f.app.store.reserved,0);
 }finally{await f.close();}
});

test('durable global slots queue reads, serialize targets, fence audit/configuration changes and drain shutdown',async()=>{
 const alpha=deferred(),beta=deferred(),write=deferred();let active=0,peak=0,downloads=0;
 const f=await fixture({requestCapacity:'101',execute:async profile=>{active++;peak=Math.max(peak,active);try{if(profile==='alpha-read')await alpha.promise;else if(profile==='beta-read')await beta.promise;else if(profile==='gamma-write')await write.promise;return {failed:false,texts:['done']};}finally{active--;}}});try {
  const a=await submit(f,'id','alpha'),b=await submit(f,'id','beta');await until(()=>f.calls.length===2);
  const a2=await submit(f,'id','alpha'),g=await submit(f,'id','gamma');
  assert.equal(data(await f.call('observe',{id:a2.id})).state,'queued');assert.equal(data(await f.call('observe',{id:g.id})).state,'queued');assert.equal(f.calls.length,2);
  f.app.targets.select('gamma').transfers.download=async()=>{downloads++;active++;peak=Math.max(peak,active);try{return {failed:false,texts:['downloaded']};}finally{active--;}};
  const download=data(await f.call('submit',{kind:'download',target:'gamma',remotePath:'/tmp/read.bin',operationKey:'multi-download-slots-1'}));assert.equal(download.state,'pending');
  assert.ok(f.app.queue.list().some(j=>j.id===download.id));assert.equal(f.app.queue.start(download.id).state,'queued');
  const job=await submit(f,'sudo id','gamma');assert.equal(f.app.queue.start(job.id).state,'queued');assert.equal(f.app.queue.get(job.id).approvalMode,'owner');
  assert.equal(downloads,0);assert.equal(f.calls.filter(call=>call.profile==='gamma-write').length,0);assert.equal(peak,2);
  assert.equal((await f.http('/api/maintenance/reserve','POST')).status,409);
  alpha.resolve();assert.equal((await observe(f,a.id)).state,'completed');assert.equal((await observe(f,a2.id)).state,'completed');assert.equal((await observe(f,g.id)).state,'completed');
  assert.equal((await observe(f,download.id)).state,'completed');await until(()=>f.calls.some(call=>call.profile==='gamma-write'));
  assert.equal(downloads,1);assert.equal(f.calls.filter(call=>call.profile==='gamma-write').length,1);assert.equal(peak,2);assert.equal(active,2);
  const closing=f.app.close();await settle();assert.equal(f.closed,false);assert.equal(f.app.queue.maintenance,true);
  beta.resolve();write.resolve();await closing;assert.equal(f.closed,true);assert.equal(peak,2);assert.equal(active,0);
  assert.equal(downloads,1);assert.equal(f.calls.filter(call=>call.profile==='gamma-write').length,1);
 }finally{alpha.resolve();beta.resolve();write.resolve();await f.close();}
 const g=await fixture({auditFails:event=>event.action==='approved'&&event.targetId==='alpha'});try {
  const a=await submit(g,'sudo id','alpha');g.app.queue.start(a.id);assert.equal((await observe(g,a.id)).state,'failed');assert.equal(g.calls.length,0);
  const stored=await observe(g,(await submit(g,'id','beta')).id,true);assert.equal(stored.output.state,'ready');assert.equal(stored.outputPage.text,'beta-read');
  const b=await submit(g,'sudo id','beta');g.profiles.get('beta-write').host='changed.example';g.app.queue.start(b.id);await g.app.queue.wait(b.id);assert.equal(g.app.queue.get(b.id).state,'failed');assert.equal(g.calls.length,1);
 }finally{await g.close();}
});

test('global import/quota reservations survive cross-target failure and maintenance races',async()=>{
 const gate=deferred();let opened=0;
 const source={inspect:()=>({allowed:true,sourceHost:'files.example.test'}),open:async()=>{opened++;await gate.promise;return {stream:Readable.from([bytes]),expectedSize:bytes.length,close(){}};}};
 const f=await fixture({source});try {
  const create=target=>f.app.targets.files.requestUpload({target,source,fileName:'same.bin',remotePath:'/tmp/same.bin'});
  const a=create('alpha'),b=create('beta'),both=Promise.allSettled([a,b]);await until(()=>opened===2);await assert.rejects(create('gamma'));assert.equal(opened,2);assert.equal(f.app.store.reserved,128);
  assert.equal((await f.http('/api/maintenance/reserve','POST')).status,409);
  f.app.queue.maintenance=true;gate.resolve();assert.deepEqual((await both).map(x=>x.status),['rejected','rejected']);assert.equal(f.app.store.reserved,0);assert.equal(f.app.queue.listAll().length,0);
  f.app.queue.maintenance=false;const accepted=await create('gamma');assert.equal(accepted.job.targetId,'gamma');f.app.queue.deny(accepted.job.id);await f.app.store.reap();
  assert.equal(f.app.store.reserved,0);assert.equal((await f.http('/api/maintenance/reserve','POST')).status,200);
  assert.equal((await f.call('submit',{kind:'command',command:'sudo id',target:'alpha',operationKey:'maintenance-refused-command'})).isError,true);await f.http('/api/maintenance/release','POST');
 }finally{gate.resolve();await f.close();}
});

test('changed target revisions reject old bootstrap/native admission and download reads cannot cross targets',async()=>{
 const f=await fixture(),g=await fixture({credentialRevision:'v2'});try {
  const seed=await f.call('show-file-transfer',transfer('alpha'));
  assert.equal((await g.call('ui-upload-begin',{transfer:transfer('alpha'),ticket:seed._meta.sshApproval.bootstrapTicket,fileName:'old.bin',size:0,sha256:createHash('sha256').update('').digest('hex')})).isError,true);
  const revision=data(await f.call('targets')).targets.find(target=>target.id==='alpha').revision;
  const stale=await g.call('artifact-begin',{operationKey:'native-stale-target-revision',target:'alpha',expectedTargetRevision:revision,fileName:'old.bin',remotePath:'/tmp/same.bin',size:bytes.length,sha256});assert.equal(stale.structuredContent.error.code,'ARTIFACT_STALE_TARGET');
  const staleCommand=await g.call('submit',{kind:'command',command:'id',operationKey:'native-stale-command-revision',target:'alpha',expectedTargetRevision:revision});assert.equal(staleCommand.structuredContent.error.code,'TARGET_REVISION_CONFLICT');assert.equal(g.calls.length,0);
  const make=async target=>{const runtime=f.app.targets.select(target),reserved=runtime.store.reserveDownload({fileName:'same.bin',remotePath:'/tmp/same.bin',elevate:false,fileTargetBound:true});return runtime.store.receiveDownload(reserved.id,{size:bytes.length,sha256},async out=>{out.end(bytes);await finished(out);});};
  const a=await make('alpha'),b=await make('beta');
  const runtime=f.app.targets.select('alpha');runtime.transfers.download=async()=>({failed:false,texts:['ready'],data:{artifactId:b.id,fileName:b.fileName,size:bytes.length,sha256}});
  const bad=data(await f.call('submit',{kind:'download',target:'alpha',remotePath:'/tmp/same.bin',operationKey:'native-cross-target-download'}));await f.app.queue.approve(bad.id);assert.equal((await f.http(`/api/${bad.id}/download`,'POST')).status,409);
  const refused=await f.call('artifact-read',{id:bad.id});assert.equal(refused.isError,true);assert.equal(refused.structuredContent.error.code,'REQUEST_REFUSED');
  runtime.transfers.download=async()=>({failed:false,texts:['ready'],data:{artifactId:a.id,fileName:a.fileName,size:bytes.length,sha256}});
  const good=data(await f.call('submit',{kind:'download',target:'alpha',remotePath:'/tmp/same.bin',operationKey:'native-owned-target-download'}));await f.app.queue.approve(good.id);
  const first=data(await f.call('artifact-read',{id:good.id,maxBytes:2})),last=data(await f.call('artifact-read',{id:good.id,offsetBytes:first.nextOffset,maxBytes:2}));
  assert.equal(first.eof,false);assert.equal(last.eof,true);assert.equal(last.totalBytes,bytes.length);assert.equal(last.sha256,sha256);assert.deepEqual(Buffer.concat([Buffer.from(first.data,'base64'),Buffer.from(last.data,'base64')]),bytes);
  assert.equal(data(await f.call('artifact-read',{id:good.id,maxBytes:2})).data,first.data,'same authorized page can be recovered without SSH replay');
  const result=await(await f.http(`/api/${good.id}/download`,'POST')).json(),url=new URL(result.downloadUrl),local=f.web+url.pathname+url.search;
  assert.equal((await fetch(local.replace(a.id,b.id))).status,409);assert.equal((await fetch(local,{method:'HEAD'})).status,200);
  assert.deepEqual(Buffer.from(await(await fetch(local)).arrayBuffer()),bytes);assert.equal((await fetch(local)).status,409);
 }finally{await f.close();await g.close();}
});
