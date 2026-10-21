import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { assessmentDiagnostic, safetyFailureDetails, validateAssessment } from '../src/domain/safety.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createRequestSafety } from '../src/application/request-safety.mjs';
import { evaluateSafety } from '../src/application/safety-evaluation.mjs';

const input={command:'id -u',target:'synthetic',environment:'synthetic Linux',context:'Read numeric fixture uid only'};
const wire=()=>({model:'jev-1.14.0',answers:{risk:{type:'choice',choice:'low_risk',confidence:0.95,probabilities:{low_risk:0.97,high_risk:0,uncertain:0.03}}},usage:{input_tokens:12,output_tokens:3}});
const response=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const assess=async body=>{let calls=0;const a=createJevAssessor({apiKey:'synthetic-secret',fetchImpl:async()=>{calls++;return response(body);}});const result=await a.assess(input);assert.equal(calls,1);return result;};
const mutations=[
  ['ANSWER_KEYS',b=>delete b.answers],['ANSWER_KEYS',b=>{b.answers.extra=b.answers.risk;}],
  ['ANSWER_TYPE',b=>{b.answers.risk.type='synthetic-private-text';}],
  ['MODEL_MISMATCH',b=>{b.model='jev-latest';}],['LABEL_DOMAIN',b=>{b.answers.risk.choice='synthetic-private-text';}],
  ['CONFIDENCE_RANGE',b=>{b.answers.risk.confidence=1.01;}],['CONFIDENCE_RANGE',b=>{b.answers.risk.confidence='synthetic-private-text';}],
  ['PROBABILITY_KEYS',b=>delete b.answers.risk.probabilities],['PROBABILITY_KEYS',b=>delete b.answers.risk.probabilities.uncertain],
  ['PROBABILITY_KEYS',b=>{b.answers.risk.probabilities.extra=0;}],
  ['PROBABILITY_RANGE',b=>{b.answers.risk.probabilities.low_risk=-1;}],['PROBABILITY_RANGE',b=>{b.answers.risk.probabilities.low_risk='synthetic-private-text';}],
  ['PROBABILITY_SUM',b=>{b.answers.risk.probabilities={low_risk:0.33333,high_risk:0.33333,uncertain:0.33333};}],
  ['CHOICE_NOT_MAX',b=>{b.answers.risk.choice='high_risk';}],
  ['USAGE_SCHEMA',b=>delete b.usage],['USAGE_SCHEMA',b=>{b.usage.output_tokens=-1;}],['USAGE_SCHEMA',b=>{b.usage.input_tokens=0.2;}],
];
for(const [i,[diagnostic,mutate]] of mutations.entries())test(`D-CODES-${i} rejects ${diagnostic} without provider text`,async()=>{
  const b=wire();mutate(b);b.private='synthetic-private-text';
  const result=await assess(b);
  assert.deepEqual(result,{status:'unavailable',reason:'invalid_response',diagnostic});
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-text|synthetic-secret/);
});

test('D-ACCEPTANCE all labels, ties and exact sum remain unchanged; valid answers never carry diagnostics',async()=>{
  for(const label of ['low_risk','high_risk','uncertain']) {
    const b=wire();b.answers.risk.choice=label;b.answers.risk.probabilities={low_risk:0,high_risk:0,uncertain:0};b.answers.risk.probabilities[label]=1;
    assert.equal((await assess(b)).label,label);
  }
  const b=wire();b.answers.risk.probabilities={low_risk:0.5,high_risk:0.5,uncertain:0};
  assert.equal((await assess(b)).status,'assessed');
  for(let i=0;i<=100;i++) {
    const p=i/100,values={low_risk:p,high_risk:1-p,uncertain:0};
    const v={status:'assessed',model:'jev-1.14.0',label:p>=0.5?'low_risk':'high_risk',confidence:0.1,probabilities:values,inputTokens:0,outputTokens:0};
    assert.ok(validateAssessment(v));assert.equal(assessmentDiagnostic(v),null);
  }
  assert.equal((await assess(wire())).diagnostic,undefined);
});

const transport=[
  ['CONTENT_TYPE','invalid_response',()=>new Response('synthetic-private-text')],
  ['BODY_MISSING','invalid_response',()=>new Response(null,{headers:{'content-type':'application/json'}})],
  ['JSON_PARSE','request_failed',()=>new Response('{synthetic-private-text',{headers:{'content-type':'application/json'}})],
  ['UTF8_DECODE','request_failed',()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}})],
  ['BODY_READ','request_failed',()=>new Response(new ReadableStream({start(c){c.error(Error('synthetic-private-text'));}}),{headers:{'content-type':'application/json'}})],
];
for(const [diagnostic,reason,make] of transport)test(`D-TRANSPORT ${diagnostic} preserves broad failure reason`,async()=>{
  let calls=0;const result=await createJevAssessor({apiKey:'synthetic-secret',fetchImpl:async()=>{calls++;return make();}}).assess(input);
  assert.deepEqual(result,{status:'unavailable',reason,diagnostic});assert.equal(calls,1);
});

test('D-PRIVACY failure sanitizer copies only fixed enums and rejects guessed status/reason/code',()=>{
  const bad={status:'unavailable',reason:'invalid_response',diagnostic:'PROBABILITY_SUM',raw:'synthetic-private-text',detail:{token:'synthetic-secret'},probabilitySum:0.99999};
  assert.deepEqual(safetyFailureDetails(bad),{reason:'invalid_response',diagnostic:'PROBABILITY_SUM'});
  for(const b of [{...bad,diagnostic:'synthetic-private-text'},{...bad,diagnostic:{toString:()=> 'PROBABILITY_SUM'}}])assert.deepEqual(safetyFailureDetails(b),{reason:'invalid_response'});
  for(const b of [null,{}, {...bad,status:'assessed'}, {...bad,reason:'synthetic-private-text'}])assert.deepEqual(safetyFailureDetails(b),{reason:'invalid_response'});
});

test('D-RETENTION observation cache and evaluation report preserve fixed codes without retry or execution',async()=>{
  const q=new ApprovalQueue({classify:()=>({class:'privileged'}),profile:'fixture',target:'fixture@localhost:22',executeOperation:()=>assert.fail('No execution')});
  const job=q.submit('sudo id');let calls=0;
  const assessor={async assess(){calls++;return {status:'unavailable',reason:'invalid_response',diagnostic:'PROBABILITY_SUM',private:'synthetic-private-text'};}};
  const service=createRequestSafety({queue:q,assessor});const a=await service.assess(job.id),b=await service.assess(job.id);
  assert.deepEqual(a.assessment,{status:'unavailable',reason:'invalid_response',diagnostic:'PROBABILITY_SUM'});
  assert.deepEqual(a.assessment,b.assessment);assert.equal(calls,1);assert.equal(q.get(job.id).state,'pending');
  const report=await evaluateSafety({cases:[{id:'S001',expected:'low_risk',input}],assessor,source:'simulated'});
  assert.deepEqual(report.records[0],{id:'S001',expected:'low_risk',status:'unavailable',reason:'invalid_response',diagnostic:'PROBABILITY_SUM',candidateMatch:false});
  assert.equal(report.unavailable,1);assert.equal(report.assessed,0);assert.equal(report.usage.inputTokens,0);
  assert.doesNotMatch(JSON.stringify([a,b,report]),/synthetic-private-text/);assert.equal(calls,2);
});
