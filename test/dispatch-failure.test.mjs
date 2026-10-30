import test from 'node:test';
import assert from 'node:assert/strict';
import {ApprovalQueue} from '../src/domain/approval-queue.mjs';
import {createCommandAutomation} from '../src/application/command-automation.mjs';
import {preparePythonSource} from '../src/adapters/ssh/python-source.mjs';
import {dispatchFailureDetails} from '../src/domain/dispatch-failure.mjs';

function fixture({testServer=false,save=()=>{},audit=()=>{}}={}){
 let changed=false,automation,effects=0,terminals=0;
 const definition={id:'fixture',revision:'a'.repeat(64),writeProfile:'fixture-write',verify(){if(changed)throw Error('SYNTHETIC_PRIVATE_TARGET');}};
 const rule={targetId:definition.id,targetRevision:definition.revision,profile:definition.writeProfile,commands:[],deniedCommands:[],sourceExecutionContract:null,testServer};
 const policy={revision:0,targets:[rule]},budget={bytes:0,count:0},events=[];
 const q=new ApprovalQueue({classify:()=>({class:'privileged'}),target:'fixture',profile:definition.writeProfile,audit:e=>{audit(e);events.push(e);},executeOperation:async()=>{effects++;return {failed:false,texts:[]};},onTerminal:job=>{terminals++;automation.onTerminal(job);}});
 automation=createCommandAutomation({queue:q,state:{policy:()=>policy,find(){},insert(){},save},definition,classify:()=>({class:'privileged'}),evaluators:{},audit:e=>events.push(e),prepareSource:preparePythonSource,sourceBudget:budget});
 return {q,automation,rule,policy,budget,events,get effects(){return effects;},get terminals(){return terminals;},changeTarget(){changed=true;}};
}

test('DISPATCH-04 actual source/target/policy guards keep distinct fixed reasons without source or raw exceptions',async t=>{
 for(const kind of ['private_plan','target_changed','policy_changed','policy_denied'])await t.test(kind,async()=>{
  const f=fixture(),request=await f.automation.runSource({source:'# SYNTHETIC_PRIVATE_BODY\npass\n',cwd:'/tmp',context:'bounded fixture'});await f.automation.drain();
  const job=f.q.get(request.job.id);assert.equal(job.state,'pending');assert.equal(job.decision.reasonCode,'source_execution_not_enabled');
  f.rule.sourceExecutionContract='python-source-v1';f.rule.automaticSudo=true;
  f.q.setDecision(job.id,{decision:'execute',reasonCode:'model_passed',policyRevision:0});
  if(kind==='private_plan')f.q.jobs.get(job.id).operation={...job.operation,sourcePlanDigest:'f'.repeat(64)};
  if(kind==='target_changed')f.changeTarget();if(kind==='policy_changed')f.policy.revision++;if(kind==='policy_denied')f.rule.deniedCommands=['python3'];
  let failure;try{f.q.startCommand(job.id);assert.fail('guard must refuse');}catch(error){failure=error;}
  const details=dispatchFailureDetails(failure);assert.equal(details.dispatchFailureReason,kind);
  assert.equal(details.dispatchFailureStage,kind==='private_plan'?'source_plan':kind==='target_changed'?'target_guard':'policy_guard');
  assert.equal(f.effects,0);assert.equal(f.q.get(job.id).state,'pending');assert.equal(f.q.rejectAutomaticDispatch(job.id,failure),false);
  assert.doesNotMatch(JSON.stringify([details,f.q.get(job.id),f.events]),/SYNTHETIC_PRIVATE/);
  f.q.deny(job.id);assert.deepEqual(f.budget,{bytes:0,count:0});assert.equal(f.terminals,1);
 });
});

test('DISPATCH-05 finishEvaluation persistence failure is not busy and normal review does not autoexecute',async()=>{
 let failed=false;
 const f=fixture({save:job=>{if(job.state==='pending'&&!failed){failed=true;throw Error('SYNTHETIC_PRIVATE_SAVE');}}});
 const request=await f.automation.runSource({source:'pass\n',cwd:'/tmp',context:'fixture'});await f.automation.drain();const job=f.q.get(request.job.id);
 assert.equal(job.state,'pending');assert.equal(job.decision.reasonCode,'execution_start_failed');assert.equal(job.decision.dispatchFailureReason,'persistence_failed');assert.equal(job.decision.dispatchFailureStage,'evaluation_persistence');assert.equal(job.decision.dispatchFailure,undefined);assert.equal(f.effects,0);
 assert.equal(f.automation.source(job.id).source,'pass\n');f.q.deny(job.id);assert.deepEqual(f.budget,{bytes:0,count:0});
});

test('DISPATCH-06 a rejected test-server source releases its plan even when failure persistence also fails',async()=>{
 let rejectWrites=false;
 const f=fixture({testServer:true,audit:e=>{if(e.action==='policy-execution-started'){rejectWrites=true;throw Error('SYNTHETIC_PRIVATE_AUDIT');}},save:()=>{if(rejectWrites)throw Error('SYNTHETIC_PRIVATE_REJECTION_SAVE');}});
 const request=await f.automation.runSource({source:'pass\n',cwd:'/tmp'});await assert.rejects(f.automation.drain());
 const job=f.q.get(request.job.id);assert.equal(job.state,'failed');assert.equal(job.decision.dispatchFailureReason,'audit_failed');assert.equal(job.decision.dispatchFailureStage,'start_audit');assert.equal(f.effects,0);assert.equal(f.terminals,1);assert.deepEqual(f.budget,{bytes:0,count:0});assert.throws(()=>f.automation.sourcePlan(job.id));
 assert.doesNotMatch(JSON.stringify([job,f.events]),/SYNTHETIC_PRIVATE/);
});
