import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ApprovalQueue} from '../src/domain/approval-queue.mjs';
import {createClaims} from '../src/application/target-router.mjs';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {prepareAgentCliPlan} from '../src/adapters/ssh/agent-cli.mjs';
import {createAgentCliService} from '../src/application/agent-cli.mjs';
import {validateAgentRelease} from '../src/domain/agent-cli.mjs';

const revision='a'.repeat(64),installationRevision='b'.repeat(64);
function release(provider='codex'){
 const name=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code',version='1.2.3';
 return validateAgentRelease(provider,{name,version,dist:{tarball:'https://registry.npmjs.org/'+name+'/-/'+name.split('/')[1]+'-'+version+'.tgz',integrity:'sha512-'+Buffer.alloc(64,7).toString('base64')}});
}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'agent-cli-service-'));
 let tick=1000,identity=0,jobId=0,service;
 const flags={targetChanged:false,enabled:true,denied:false,read:null,execute:null,prepare:null,auditFailure:false};
 const calls={read:[],execute:[],audit:[],policy:[]};
 const journal=createCommandState(root),outputs=new CommandOutputs(root,{now:()=>tick});
 const cleanup=[];let journalClosed=false;const closeJournal=journal.close.bind(journal);
 journal.close=()=>{if(!journalClosed){closeJournal();journalClosed=true;}};
 const definition={id:'fixture',revision,writeProfile:'fixture-write',get enabled(){return flags.enabled;},verify(){if(flags.targetChanged)throw Error('Target changed');}};
 const claim=createClaims(1);
 const queue=new ApprovalQueue({classify:()=>({class:'privileged'}),target:'fixture@host:22',profile:'fixture-write',identity:{targetId:'fixture',targetRevision:revision},claimExecution:claim,now:()=>tick,idFactory:()=>String(++jobId).padStart(48,'0'),audit:event=>{if(flags.auditFailure)throw Error('SYNTHETIC_PRIVATE_AUDIT');calls.audit.push(event);},executeOperation:(_,id)=>service.execute(id),onTerminal:job=>service?.onTerminal(job)});
 const ports={queue,journal,outputs,resolveTarget:id=>id==='fixture'?definition:null,
  readInstallation:async(provider,binding)=>{calls.read.push({provider,binding});return flags.read?flags.read(provider,binding):{provider,managed:false,installed:false,version:null,installationRevision,login:'not_checked',private:'SYNTHETIC_PRIVATE'};},
  catalog:{get:async provider=>({release:release(provider),expiresAt:tick+300000})},
  preparePlan:args=>flags.prepare?flags.prepare(args):prepareAgentCliPlan(args),
  executePlan:async(plan,verify)=>{verify();calls.execute.push(plan);return flags.execute?flags.execute(plan,verify):{failed:false,texts:['CLI installation completed'],data:{agentCli:{provider:plan.agentCli.provider,state:'completed',login:'not_checked'}}};},
  checkPolicy:(plan,binding)=>{calls.policy.push({plan,binding});if(flags.denied)throw Error('Policy denied');},now:()=>tick,nonce:()=>(++identity).toString(16).padStart(48,'0')};
 service=createAgentCliService(ports);
 queue.beforeCommandStart=job=>service.beforeStart(job);
 const body=(preview,key='request-key-00000001')=>({planId:preview.planId,request:{targetId:'fixture',targetRevision:revision,profile:'fixture-write',provider:preview.release.provider,action:'install',releaseDigest:preview.release.releaseDigest,expectedInstallationRevision:preview.installation.installationRevision,requestKey:key}});
 t.after(()=>{service.close();for(const close of cleanup)close();journal.close();outputs.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+'\\')||resolve(root).startsWith(resolve(tmpdir())+'/'));assert.ok(!lstatSync(root).isSymbolicLink());rmSync(root,{recursive:true,force:true});});
 return {root,queue,journal,outputs,flags,calls,ports,get service(){return service;},replaceService(next){service=next;},beforeCleanup(fn){cleanup.push(fn);},body,clock(value){tick=value;},preview:provider=>service.preview({targetId:'fixture',provider:provider??'codex'}),releaseClaim:claim};
}

test('preview binds exact registered target, release, revision and lifetime; strips private extras',async t=>{
 const f=fixture(t),p=await f.preview();assert.equal(p.binding.targetRevision,revision);assert.equal(p.binding.profile,'fixture-write');assert.equal(p.installation.installationRevision,installationRevision);assert.equal(p.expiresAt,301000);
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.binding)&&Object.isFrozen(p.installation)&&Object.isFrozen(p.release));assert.ok(!JSON.stringify(p).includes('SYNTHETIC_PRIVATE'));assert.equal(f.calls.execute.length,0);
 await assert.rejects(()=>f.service.preview({targetId:'foreign',provider:'codex'}));await assert.rejects(()=>f.service.preview({targetId:'fixture',provider:'codex',command:'id'}));
});
test('fixed source plan binds helper argv and target; root elevation and arbitrary source are absent',()=>{
 const binding={targetId:'fixture',targetRevision:revision,profile:'fixture-write'};
 const plan=prepareAgentCliPlan({action:'install',provider:'codex',binding,release:release(),expectedInstallationRevision:installationRevision,expiresAt:301000,operationId:'c'.repeat(48)});
 assert.equal(plan.manifest.elevate,false);assert.equal(plan.manifest.cwd,'/');assert.ok(plan.manifest.sourceBytes<=16384);assert.equal(plan.manifest.targetRevision,revision);
 assert.deepEqual(JSON.parse(plan.manifest.argvJson),['install','codex','1.2.3',release().integrity,installationRevision,'301000','c'.repeat(48)]);
 assert.throws(()=>prepareAgentCliPlan({action:'shell',provider:'codex',binding}));
 assert.throws(()=>prepareAgentCliPlan({action:'inspect',provider:'codex',binding,release:release()}));
 assert.throws(()=>prepareAgentCliPlan({action:'status',provider:'codex',binding,operationId:'../bad'}));
});
test('submit persists a pending owner job and never executes before actual queue approval',async t=>{
 const f=fixture(t),p=await f.preview(),job=f.service.submit(f.body(p));
 assert.equal(job.state,'pending');assert.equal(job.expiresAt,p.expiresAt);assert.equal(f.calls.execute.length,0);assert.equal(f.journal.find('agent-cli:request-key-00000001').job.id,job.id);
 const source=f.service.source(job.id);assert.equal(source.manifest.sourceBytes,Buffer.byteLength(source.source));assert.equal(source.planDigest,job.operation.sourcePlanDigest);
});
test('owner queue approval executes once and stores output with exact execution/target/plan binding',async t=>{
 const f=fixture(t),job=f.service.submit(f.body(await f.preview()));const result=await f.queue.approve(job.id);
 assert.equal(result.state,'completed');assert.equal(result.approvalMode,'owner');assert.equal(f.calls.execute.length,1);assert.equal(result.result.output.state,'ready');
 const output=f.outputs.read({outputId:result.result.output.id,format:'json'},binding=>{assert.equal(binding.executionId,job.id);assert.equal(binding.targetId,'fixture');assert.equal(binding.targetRevision,revision);assert.equal(binding.operationDigest,job.operation.sourcePlanDigest);});
 assert.equal(JSON.parse(output.text).data.agentCli.login,'not_checked');assert.equal(output.eof,true);assert.equal(f.journal.find('agent-cli:request-key-00000001').job.state,'completed');assert.throws(()=>f.service.source(job.id));
 assert.ok(f.calls.audit.some(event=>event.action==='approved'&&event.approvalMode==='owner'));
});
test('same request key/body returns same persistent job even after plan expiry, without new dispatch',async t=>{
 const f=fixture(t),p=await f.preview(),body=f.body(p),job=f.service.submit(body);await f.queue.approve(job.id);f.clock(999999);
 assert.equal(f.service.submit(body).id,job.id);assert.equal(f.calls.execute.length,1);
 const reordered={planId:body.planId,request:Object.fromEntries(Object.entries(body.request).reverse())};assert.equal(f.service.submit(reordered).id,job.id);
 for(const changed of [{...body,planId:'d'.repeat(48)},{...body,request:{...body.request,action:'update'}},{...body,request:{...body.request,expectedInstallationRevision:'d'.repeat(64)}}])assert.throws(()=>f.service.submit(changed),/conflict/);
});
test('new keys cannot queue a second same-target/provider install while one is pending or running',async t=>{
 const f=fixture(t),p=await f.preview(),job=f.service.submit(f.body(p));assert.throws(()=>f.service.submit(f.body(p,'request-key-00000002')),/already/);assert.equal(f.queue.listAll().length,1);assert.equal(f.calls.execute.length,0);
 f.queue.start(job.id);assert.throws(()=>f.service.submit(f.body(p,'request-key-00000002')),/already/);await f.queue.wait(job.id);assert.equal(f.calls.execute.length,1);
});
test('expired preview and approval deadline never dispatch',async t=>{
 const f=fixture(t),p=await f.preview(),body=f.body(p);f.clock(p.expiresAt);assert.throws(()=>f.service.submit(body));assert.equal(f.queue.listAll().length,0);
 f.clock(1000);const p2=await f.preview(),job=f.service.submit(f.body(p2));f.clock(p2.expiresAt);assert.equal(f.queue.get(job.id).state,'expired');await assert.rejects(()=>f.queue.approve(job.id));assert.equal(f.calls.execute.length,0);
});
test('changed target, current deny policy and maintenance prevent dispatch at actual approval',async t=>{
 const f=fixture(t),job=f.service.submit(f.body(await f.preview()));
 f.flags.targetChanged=true;await assert.rejects(()=>f.queue.approve(job.id));f.flags.targetChanged=false;
 f.flags.denied=true;await assert.rejects(()=>f.queue.approve(job.id));f.flags.denied=false;
 f.queue.maintenance=true;await assert.rejects(()=>f.queue.approve(job.id));f.queue.maintenance=false;
 assert.equal(f.calls.execute.length,0);assert.equal(f.queue.get(job.id).state,'pending');
});
test('global execution claim is shared with existing queue and prevents a second start',async t=>{
 const f=fixture(t),job=f.service.submit(f.body(await f.preview())),releaseClaim=f.releaseClaim();
 await assert.rejects(()=>f.queue.approve(job.id));assert.equal(f.calls.execute.length,0);releaseClaim();assert.equal((await f.queue.approve(job.id)).state,'completed');
});
test('target change after owner admission is rechecked before remote effect and leaves unknown',async t=>{
 const f=fixture(t),job=f.service.submit(f.body(await f.preview()));f.queue.start(job.id);f.flags.targetChanged=true;
 const result=await f.queue.wait(job.id);assert.equal(result.state,'unknown');assert.equal(f.calls.execute.length,0);
});
test('plan expiry between owner admission and dispatch prevents the remote effect',async t=>{
 const f=fixture(t),p=await f.preview(),job=f.service.submit(f.body(p));f.queue.start(job.id);f.clock(p.expiresAt);
 const result=await f.queue.wait(job.id);assert.equal(result.state,'unknown');assert.equal(f.calls.execute.length,0);
});
test('output reservation failure never dispatches and cannot be replayed',async t=>{
 const f=fixture(t),body=f.body(await f.preview()),job=f.service.submit(body);f.outputs.reserve=()=>{throw Error('SYNTHETIC_PRIVATE_DISK');};
 const result=await f.queue.approve(job.id);assert.equal(result.state,'unknown');assert.equal(f.calls.execute.length,0);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DISK'));assert.equal(f.service.submit(body).id,job.id);await assert.rejects(()=>f.queue.approve(job.id));
});
test('transport result loss and malformed outcome stay unknown without automatic SSH retry',async t=>{
 const f=fixture(t),body=f.body(await f.preview()),job=f.service.submit(body);f.flags.execute=()=>{throw Error('SYNTHETIC_PRIVATE_TRANSPORT');};
 const result=await f.queue.approve(job.id);assert.equal(result.state,'unknown');assert.equal(f.calls.execute.length,1);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_TRANSPORT'));
 assert.equal(f.service.submit(body).id,job.id);assert.equal(f.calls.execute.length,1);
 const p2=await f.preview(),job2=f.service.submit(f.body(p2,'request-key-00000002'));f.flags.execute=()=>({texts:[]});assert.equal((await f.queue.approve(job2.id)).state,'unknown');
});
test('journal restart expires pending and marks running unknown; missing private plan never reconstructs',async t=>{
 const f=fixture(t),body=f.body(await f.preview()),job=f.service.submit(body);
 const second=f.service.submit(f.body(await f.preview('claude'),'request-key-00000002'));f.journal.save({...second,state:'running'});f.service.close();f.journal.close();
 const restored=createCommandState(f.root);f.beforeCleanup(()=>restored.close());const saved=restored.find('agent-cli:request-key-00000001');assert.equal(saved.job.state,'expired');assert.equal(restored.find('agent-cli:request-key-00000002').job.state,'unknown');
 // Keep the original live queue pending to test defense even if a composition forgot normalization.
 const next=createAgentCliService({...f.ports,journal:restored});f.replaceService(next);assert.equal(next.submit(body).id,job.id);await assert.rejects(()=>f.queue.approve(job.id));assert.equal(f.calls.execute.length,0);
});
test('audit or durable admission failure produces no executable job and no remote call',async t=>{
 const f=fixture(t),p=await f.preview();f.flags.auditFailure=true;assert.throws(()=>f.service.submit(f.body(p)));assert.equal(f.queue.listAll().length,0);f.flags.auditFailure=false;
 f.journal.insert=()=>{throw Error('SYNTHETIC_PRIVATE_SQLITE');};assert.throws(()=>f.service.submit(f.body(p)));assert.equal(f.queue.listAll()[0].state,'unknown');await assert.rejects(()=>f.queue.approve(f.queue.listAll()[0].id));assert.equal(f.calls.execute.length,0);
});
test('unsupported fields, disabled targets and changed preview snapshots are refused before submit',async t=>{
 const f=fixture(t),p=await f.preview(),body=f.body(p);
 for(const bad of [{...body,command:'id'},{...body,request:{...body.request,package:'arbitrary'}},{...body,request:{...body.request,expectedInstallationRevision:'c'.repeat(64)}},{...body,request:{...body.request,profile:'foreign'}}])assert.throws(()=>f.service.submit(bad));
 f.flags.enabled=false;assert.throws(()=>f.service.submit(body));await assert.rejects(()=>f.preview());assert.equal(f.queue.listAll().length,0);
});
test('preview rejects target drift, false login claims and invalid installation metadata',async t=>{
 const f=fixture(t);f.flags.read=async()=>{f.flags.targetChanged=true;return {};};await assert.rejects(()=>f.preview());f.flags.targetChanged=false;
 for(const extra of [{login:'authenticated'},{installationRevision:'not-a-hash'},{managed:true},{version:'1.2.3;id'}]){
  f.flags.read=provider=>({provider,managed:false,installed:false,version:null,installationRevision,login:'not_checked',...extra});await assert.rejects(()=>f.preview());
 }
 assert.equal(f.calls.execute.length,0);
});
test('preview cache has a fixed capacity and exact expiry frees only expired entries',async t=>{
 const f=fixture(t);for(let i=0;i<64;i++)await f.preview();await assert.rejects(()=>f.preview(),/capacity/);f.clock(301000);assert.ok(await f.preview());
});
test('existing queue keeps its one-hour default and refuses deadlines outside its authority window',()=>{
 const queue=new ApprovalQueue({classify:()=>({class:'privileged'}),target:'fixture',profile:'fixture-write',now:()=>1000,executeOperation:async()=>({failed:false,texts:[]})});
 for(const expiresAt of [null,NaN,1000,999,3601001])assert.throws(()=>queue.submitOperation({kind:'command',command:'id'},'privileged',{expiresAt}));
 assert.equal(queue.listAll().length,0);assert.equal(queue.submitOperation({kind:'command',command:'id'}).expiresAt,3601000);
});
test('changed queued operation or profile cannot consume the private execution plan',async t=>{
 const f=fixture(t),job=f.service.submit(f.body(await f.preview())),raw=f.queue.jobs.get(job.id),original=raw.operation;
 raw.operation=Object.freeze({...original,agentCliAction:'update'});await assert.rejects(()=>f.queue.approve(job.id));raw.operation=original;
 raw.profile='foreign';await assert.rejects(()=>f.queue.approve(job.id));assert.equal(f.calls.execute.length,0);
});
test('false catalog provider, release digest or extended lifetime never becomes a preview',async t=>{
 const f=fixture(t);
 for(const value of [{release:release('claude'),expiresAt:301000},{release:{...release(),releaseDigest:'sha256:'+'c'.repeat(64)},expiresAt:301000},{release:release(),expiresAt:301001}]){
  f.ports.catalog.get=async()=>value;await assert.rejects(()=>f.preview());
 }
 assert.equal(f.calls.execute.length,0);
});
test('service close prevents a late inspection from restoring previews or execution authority',async t=>{
 const f=fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;});f.flags.read=()=>gate;
 const result=f.preview();f.service.close();release({provider:'codex',managed:false,installed:false,version:null,installationRevision,login:'not_checked'});
 await assert.rejects(result,/closed/);await assert.rejects(()=>f.preview(),/closed/);assert.equal(f.queue.listAll().length,0);assert.equal(f.calls.execute.length,0);
});
