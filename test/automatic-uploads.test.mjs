import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createApplication} from '../app.mjs';
import {hash} from '../src/domain/validation.mjs';
import {validateCommandPolicy} from '../src/domain/command-policy.mjs';

const bytes=Buffer.from('fixture file'),meta={fileName:'fixture.txt',remotePath:'/tmp/fixture.txt',size:bytes.length,sha256:hash(bytes),overwrite:false,elevate:false};
const source=()=>({inspect:()=>({allowed:true,sourceHost:'fixture.test'}),open:async()=>({stream:Readable.from([bytes]),expectedSize:bytes.length,close(){}})});
async function fixture(run,{automation=true,auditFails=()=>false}={}){
 const root=await mkdtemp(join(tmpdir(),'automatic-upload-')),effects=[],events=[],profiles=new Map();let app;
 const entries=['alpha','beta'].map(id=>({id,displayName:id,readProfile:id+'-read',writeProfile:id+'-write',credentialRevision:'v1'}));
 for(const e of entries)for(const name of [e.readProfile,e.writeProfile])profiles.set(name,{host:e.id+'.test',user:'fixture',port:22,trustedHostKey:'SHA256:'+e.id,readOnly:name.endsWith('-read')});
 try{
  app=await createApplication({registry:{getProfile:name=>profiles.get(name),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>assert.fail('No command execution'),audit:event=>{if(auditFails(event))throw Error('fixture audit failure');events.push(event);},transferRoot:root,uiHtml:'<html></html>',env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_COMMAND_AUTOMATION:String(automation),BRIDGE_TARGETS:JSON.stringify(entries),BRIDGE_DEFAULT_TARGET:'alpha'}});
  for(const e of entries){const runtime=app.targets.select(e.id);runtime.transfers.upload=async operation=>{const fd=await runtime.store.verified(operation.artifactId);try{const chunks=[];for await(const part of fd.createReadStream({start:0,autoClose:false}))chunks.push(part);assert.deepEqual(Buffer.concat(chunks),bytes);}finally{await fd.close();}effects.push({target:e.id,...operation});return{failed:false,texts:['uploaded']};};}
  await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+app.adminHttp.address().port;
  const api=async(path,body)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer fixture-owner',Origin:'https://owner.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
  const set=async(flag,target='alpha',changes={})=>{const current=(await api('/api/command-policy')).body,binding=current.bindings.find(b=>b.targetId===target),old=current.targets.find(r=>r.targetId===target),rule=old??{targetId:target,targetRevision:binding.targetRevision,profile:binding.profile,commands:[],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}};Object.assign(rule,changes);if(flag!==undefined)rule.automaticUploads=flag;const policy={targets:[...current.targets.filter(r=>r.targetId!==target),rule]},proposal={policy,expectedRevision:current.revision},reviewed=await api('/api/command-policy/review',proposal);assert.equal(reviewed.status,200);const stored=await api('/api/command-policy',{...proposal,reviewToken:reviewed.body.reviewToken,acknowledged:true});assert.equal(stored.status,200);return{reviewed:reviewed.body,stored:stored.body,proposal};};
  const upload=async(target='alpha',changes={})=>(await app.targets.files.requestUpload({target,source:source(),...meta,...changes})).job;
  const finish=async job=>{await app.queue.wait(job.id);return app.queue.get(job.id);};
  await run({app,api,set,upload,finish,effects,events,profiles});
 }finally{await app?.close();await rm(root,{recursive:true,force:true});}
}

test('uploads default to owner approval; exact reviewed opt-in applies to one target and can be disabled',async()=>fixture(async f=>{
 const before=await f.upload();assert.equal(before.state,'pending');assert.equal(f.effects.length,0);f.app.queue.deny(before.id);
 await f.set(undefined);const legacy=await f.upload();assert.equal(legacy.state,'pending');f.app.queue.deny(legacy.id);
 const {reviewed}=await f.set(true);assert.equal(reviewed.feedback[0].level,'high_risk');assert.match(reviewed.feedback[0].warning,/파일 자동업로드/);
 const a=await f.finish(await f.upload());assert.equal(a.state,'completed');assert.equal(a.approvalMode,'automatic');assert.equal(a.decision.reasonCode,'upload_policy');assert.equal(f.effects.length,1);
 const b=await f.upload('beta');assert.equal(b.state,'pending');assert.equal(f.effects.length,1);f.app.queue.deny(b.id);
 assert.ok(f.events.some(e=>e.action==='policy-execution-started'&&e.kind==='upload'&&e.approvalMode==='automatic'&&e.decision.policyRevision===2));
 assert.throws(()=>f.app.targets.select('alpha').queue.startUpload(a.id),/not pending/);assert.equal(f.effects.length,1);
 await f.set(false);const off=await f.upload();assert.equal(off.state,'pending');assert.equal(f.effects.length,1);f.app.queue.deny(off.id);
}));

test('file picker and imported files share policy; overwrite and sudo always retain owner approval',async()=>fixture(async f=>{
 await f.set(true);const files=f.app.targets.select('alpha').files;
 const item=await files.beginUpload(meta);await files.appendUpload({id:item.id,sequence:0,bytes});const a=await f.finish(await files.finishUpload(item.id));assert.equal(a.approvalMode,'automatic');assert.equal(f.effects.length,1);
 for(const changes of [{overwrite:true},{elevate:true},{elevate:true,overwrite:true}]){const job=await f.upload('alpha',changes);assert.equal(job.state,'pending');assert.equal(job.approvalMode,undefined);assert.throws(()=>f.app.targets.select('alpha').queue.startUpload(job.id));assert.throws(()=>f.app.targets.select('alpha').queue.start(job.id,true));f.app.queue.deny(job.id);}
 assert.equal(f.effects.length,1);
}));

test('invalid flag and altered unconfirmed policy cannot grant upload authority',async()=>fixture(async f=>{
 const current=(await f.api('/api/command-policy')).body,binding=current.bindings[0],rule={targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,commands:[],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}};
 for(const automaticUploads of ['true',1,null,{}])assert.throws(()=>validateCommandPolicy({targets:[{...rule,automaticUploads}]}));
 const proposal={expectedRevision:current.revision,policy:{targets:[rule]}},review=await f.api('/api/command-policy/review',proposal);
 const tampered={...proposal,policy:{targets:[{...rule,automaticUploads:true}]},reviewToken:review.body.reviewToken,acknowledged:true};assert.equal((await f.api('/api/command-policy',tampered)).status,409);
 const missing=await f.api('/api/command-policy',{...tampered,reviewToken:undefined});assert.equal(missing.status,409);const job=await f.upload();assert.equal(job.state,'pending');assert.equal(f.effects.length,0);f.app.queue.deny(job.id);
}));

test('revocation while importing and stale target fencing prevent automatic publication',async()=>fixture(async f=>{
 await f.set(true);let entered,release;const opened=new Promise(r=>entered=r),held=new Promise(r=>release=r),bound=source();
 const incoming=f.app.targets.files.requestUpload({target:'alpha',...meta,source:{inspect:bound.inspect,open:async()=>{entered();await held;return bound.open();}}});await opened;await f.set(false);release();const job=(await incoming).job;assert.equal(job.state,'pending');f.app.queue.deny(job.id);assert.equal(f.effects.length,0);
 await f.set(true);f.profiles.get('alpha-write').host='changed.test';const stale=await f.upload();assert.equal(stale.state,'pending');f.app.queue.deny(stale.id);assert.equal(f.effects.length,0);
}));

test('busy execution stays pending and never retries automatically when a slot becomes free',async()=>fixture(async f=>{
 await f.set(true);let release;const held=new Promise(r=>release=r),runtime=f.app.targets.select('alpha'),execute=runtime.transfers.upload;runtime.transfers.upload=async op=>{await held;return execute(op);};
 const first=await f.upload(),second=await f.upload();assert.equal(second.state,'pending');release();await f.finish(first);assert.equal(f.app.queue.get(second.id).state,'pending');assert.equal(f.effects.length,1);f.app.queue.deny(second.id);
}));

test('execution audit failure grants no upload and is not silently retried',async()=>fixture(async f=>{
 await f.set(true);const job=await f.upload();assert.equal(job.state,'pending');assert.equal(job.approvalMode,undefined);assert.equal(f.effects.length,0);assert.throws(()=>f.app.targets.select('alpha').queue.startUpload(job.id),/audit failure/);assert.equal(f.effects.length,0);f.app.queue.deny(job.id);
},{auditFails:e=>e.action==='policy-execution-started'}));

test('global automation off and blocked file source cannot cause automatic transmission',async()=>{
 await fixture(async f=>{const job=await f.upload();assert.equal(job.state,'pending');assert.equal(f.effects.length,0);f.app.queue.deny(job.id);},{automation:false});
 await fixture(async f=>{await f.set(true);const r=await f.app.targets.files.requestUpload({...meta,target:'alpha',source:{inspect:()=>({allowed:false,sourceHost:'blocked.test'}),open:()=>assert.fail('Blocked source fetched')}});assert.equal(r.type,'source-unavailable');assert.equal(f.effects.length,0);assert.equal(f.app.queue.jobs.size,0);});
});


test('test server bypass covers elevated overwrite uploads only on the reviewed target and is revoked at dispatch',async()=>fixture(async f=>{
 await f.set(false,'alpha',{testServer:true,automaticSudo:false});
 const first=await f.finish(await f.upload('alpha',{overwrite:true,elevate:true}));
 assert.equal(first.state,'completed');assert.equal(first.decision.reasonCode,'test_server_bypass');assert.equal(first.approvalMode,'automatic');
 const other=await f.upload('beta',{overwrite:true,elevate:true});assert.equal(other.state,'pending');f.app.queue.deny(other.id);
 await f.set(false,'alpha',{testServer:false});
 const stopped=await f.upload('alpha',{overwrite:true,elevate:true});assert.equal(stopped.state,'pending');f.app.queue.deny(stopped.id);
 assert.equal(f.effects.length,1);
}));
