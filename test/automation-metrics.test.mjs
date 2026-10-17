import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {createAutomationMetrics} from '../src/application/automation-metrics.mjs';

test('metrics project only recorded decisions, preserve target/window boundaries and distinguish unknown cost/quality',async()=>{
  const root=await mkdtemp(join(tmpdir(),'metrics-'));let state;
  try{
    state=createCommandState(root);const now=200_000_000;
    const add=(id,fields)=>state.insert({id,createdAt:now-1000,targetId:'alpha',state:'completed',command:'PRIVATE_COMMAND_SENTINEL',operation:{context:'PRIVATE_CONTEXT_SENTINEL'},...fields},undefined,id);
    add('bypass',{approvalMode:'automatic',decision:{reasonCode:'command_set'}});
    add('model',{approvalMode:'automatic',decision:{reasonCode:'model_passed',provider:'jev',assessment:{status:'assessed',inputTokens:120,outputTokens:20},evaluation:{latencyMs:200},attempts:[]}});
    add('review',{approvalMode:'owner',decision:{reasonCode:'model_review',provider:'jev',assessment:{status:'assessed',inputTokens:100,outputTokens:10},evaluation:{latencyMs:400},attempts:[]}});
    add('fallback',{targetId:'beta',approvalMode:'automatic',decision:{reasonCode:'model_passed',provider:'luna',assessment:{status:'assessed'},attempts:[{provider:'jev',reason:'evaluation_failed'},{provider:'sonnet',reason:'not_configured'}]}});
    add('old',{createdAt:now-86_400_001});add('future',{createdAt:now+1});
    const get=createAutomationMetrics({state,now:()=>now}),all=get();
    assert.equal(all.total,4);assert.equal(all.commandSetApprovals,1);assert.equal(all.modelApprovals,2);assert.equal(all.ownerApprovalsAfterAssessment,1);
    assert.deepEqual(all.providers.jev,{calls:3,failures:1,inputTokens:220,outputTokens:30,usageUnknownCalls:1,latencySamples:2,latencyMs:600});
    assert.equal(all.providers.luna.usageUnknownCalls,1);assert.equal(all.providers.sonnet,undefined);assert.equal(all.billedAmount,null);
    const alpha=get('alpha');assert.equal(alpha.total,3);assert.equal(alpha.providers.jev.calls,2);assert.equal(alpha.providers.luna,undefined);
    assert.doesNotMatch(JSON.stringify(all),/PRIVATE_COMMAND|PRIVATE_CONTEXT/);assert.equal(get('other').total,0);
  }finally{state?.close();await rm(root,{recursive:true,force:true});}
});
test('disabled automation reports unavailable measurements rather than zero observed use',()=>{
  const value=createAutomationMetrics({now:()=>123})();assert.equal(value.available,false);assert.equal(value.billedAmount,null);
});
