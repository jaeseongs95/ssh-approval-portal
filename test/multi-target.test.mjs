import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createApplication} from '../app.mjs';

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
  const targets=(await f.call('list-targets')).structuredContent;assert.equal(targets.defaultTarget,'alpha');assert.equal(targets.targets.length,4);
  assert.ok(!JSON.stringify(targets).includes('readProfile'));assert.ok(!JSON.stringify(targets).includes('SHA256'));
  for(const target of ['unknown','offline','127.0.0.1','__proto__']) assert.equal((await f.call('run-command',{command:'sudo id',target})).isError,true);
  const read=await f.call('read-command',{command:'id',target:'beta'});assert.equal(read.structuredContent.targetId,'beta');assert.equal((await f.call('read-command-output',{outputId:read.structuredContent.output.id,target:'beta'})).content[0].text,'beta-read');
  const a=(await f.call('run-command',{command:'sudo same'})).structuredContent,b=(await f.call('run-command',{command:'sudo same',target:'beta'})).structuredContent;
  assert.equal(a.targetId,'alpha');assert.equal(b.targetId,'beta');assert.equal(a.target,'synthetic@alpha.example.test:22');
  assert.equal((await fetch(f.web+'/api/targets')).status,401);
  const list=await(await f.http('/api/requests?target=beta')).json();assert.deepEqual(list.map(x=>x.id),[b.id]);
  assert.equal((await f.http('/api/requests?target=unknown')).status,409);
  assert.equal((await f.http(`/api/${a.id}/approve?target=beta`,'POST')).status,409);assert.equal(f.calls.length,1);
  const cardA=await f.call('show-approval',{id:a.id}),cardB=await f.call('show-approval',{id:b.id});
  assert.equal(cardB._meta.sshApproval.targetDisplayName,'이름 beta');
  assert.equal((await f.call('ui-decide-request',{id:b.id,action:'approve',ticket:cardA._meta.sshApproval.approvalTicket})).isError,true);
  const decisions=await Promise.all([1,2].map(()=>f.call('ui-decide-request',{id:a.id,action:'approve',ticket:cardA._meta.sshApproval.approvalTicket})));
  assert.equal(decisions.filter(x=>x.isError).length,1);await f.app.queue.wait(a.id);assert.equal(f.calls.filter(x=>x.profile==='alpha-write').length,1);
  await f.http(`/api/${b.id}/approve`,'POST');assert.equal(f.calls.filter(x=>x.profile==='beta-write').length,1);
  assert.equal((await f.call('get-request-status',{id:b.id})).structuredContent.targetId,'beta');
 }finally{await f.close();}
 const g=await fixture({noDefault:true});try {assert.equal((await g.call('run-command',{command:'sudo id'})).isError,true);assert.equal(g.calls.length,0);assert.equal((await g.call('read-command',{command:'id',target:'beta'})).isError,undefined);}finally{await g.close();}
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
  assert.deepEqual(f.calls.map(x=>x.artifactId),[a.id,b.id]);await f.app.store.reap();assert.equal(f.app.store.reserved,0);assert.deepEqual((await readdir(f.root)).filter(name=>!name.startsWith('maintenance.sqlite')),['command-outputs']);
  const reserve=target=>f.app.targets.files.beginUpload({target,fileName:'quota.bin',remotePath:'/tmp/quota.bin',size:64,sha256,overwrite:false,elevate:false});
  const first=await reserve('alpha'),second=await reserve('beta');assert.equal(f.app.store.reserved,128);
  await assert.rejects(reserve('gamma'));assert.equal(f.app.store.size,2);
  await f.app.targets.select('alpha').store.remove(first.id);const third=await reserve('gamma');
  await f.app.targets.select('beta').store.remove(second.id);await f.app.targets.select('gamma').store.remove(third.id);assert.equal(f.app.store.reserved,0);
 }finally{await f.close();}
});

test('global execution slots, per-target serialization, audit failures, configuration fencing and shutdown drain',async()=>{
 const gate=deferred();const f=await fixture({requestCapacity:'101',execute:async()=>{await gate.promise;return {failed:false,texts:['done']};}});try {
  const a=f.app.targets.commands.read('id','alpha'),b=f.app.targets.commands.read('id','beta');await until(()=>f.calls.length===2);
  await assert.rejects(f.app.targets.commands.read('id','alpha'));await assert.rejects(f.app.targets.commands.read('id','gamma'));assert.equal(f.calls.length,2);
  const download=f.app.targets.files.requestDownload({target:'gamma',remotePath:'/tmp/read.bin',elevate:false});assert.equal(download.state,'pending');assert.ok(f.app.queue.list().some(j=>j.id===download.id),'A deferred download is visible for owner review');assert.throws(()=>f.app.queue.start(download.id));f.app.queue.deny(download.id);
  const job=f.app.queue.submit('sudo id',false,'gamma');assert.throws(()=>f.app.queue.start(job.id));assert.equal(f.app.queue.get(job.id).state,'pending');f.app.queue.deny(job.id);
  assert.equal((await f.http('/api/maintenance/reserve','POST')).status,409);
  const closing=f.app.close();await settle();assert.equal(f.closed,false);assert.equal(f.app.queue.maintenance,true);
  gate.resolve();await Promise.all([a,b,closing]);assert.equal(f.closed,true);
 }finally{gate.resolve();await f.close();}
 const g=await fixture({auditFails:event=>event.action==='approved'&&event.targetId==='alpha'});try {
  const a=g.app.queue.submit('sudo id',false,'alpha');assert.throws(()=>g.app.queue.start(a.id));assert.equal(g.calls.length,0);
  const stored=await g.app.targets.commands.read('id','beta');assert.equal(stored.output.state,'ready');assert.deepEqual(stored.texts,[]);
  g.profiles.get('beta-write').host='changed.example';const b=g.app.queue.submit('sudo id',false,'beta');g.app.queue.start(b.id);await g.app.queue.wait(b.id);assert.equal(g.app.queue.get(b.id).state,'failed');assert.equal(g.calls.length,1);
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
  assert.equal((await f.call('run-command',{command:'sudo id',target:'alpha'})).isError,true);await f.http('/api/maintenance/release','POST');
 }finally{gate.resolve();await f.close();}
});

test('changed/restarted target contexts reject old bootstrap and download capabilities cannot cross targets',async()=>{
 const f=await fixture(),g=await fixture({credentialRevision:'v2'});try {
  const seed=await f.call('show-file-transfer',transfer('alpha'));
  assert.equal((await g.call('ui-upload-begin',{transfer:transfer('alpha'),ticket:seed._meta.sshApproval.bootstrapTicket,fileName:'old.bin',size:0,sha256:createHash('sha256').update('').digest('hex')})).isError,true);
  const make=async target=>{const runtime=f.app.targets.select(target),reserved=runtime.store.reserveDownload({fileName:'same.bin',remotePath:'/tmp/same.bin',elevate:false});return runtime.store.receiveDownload(reserved.id,{size:bytes.length,sha256},async out=>{out.end(bytes);await finished(out);});};
  const a=await make('alpha'),b=await make('beta');
  const runtime=f.app.targets.select('alpha');runtime.transfers.download=async()=>({failed:false,texts:['ready'],data:{artifactId:b.id,fileName:b.fileName}});
  const bad=f.app.targets.files.requestDownload({target:'alpha',remotePath:'/tmp/same.bin',elevate:false});await f.app.queue.approve(bad.id);assert.equal((await f.http(`/api/${bad.id}/download`,'POST')).status,409);
  runtime.transfers.download=async()=>({failed:false,texts:['ready'],data:{artifactId:a.id,fileName:a.fileName}});
  const good=f.app.targets.files.requestDownload({target:'alpha',remotePath:'/tmp/same.bin',elevate:false});await f.app.queue.approve(good.id);
  const result=await(await f.http(`/api/${good.id}/download`,'POST')).json(),url=new URL(result.downloadUrl),local=f.web+url.pathname+url.search;
  assert.equal((await fetch(local.replace(a.id,b.id))).status,409);assert.equal((await fetch(local,{method:'HEAD'})).status,200);
  assert.deepEqual(Buffer.from(await(await fetch(local)).arrayBuffer()),bytes);assert.equal((await fetch(local)).status,409);
 }finally{await f.close();await g.close();}
});
