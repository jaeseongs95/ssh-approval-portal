import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SAFETY_PROTOCOL, SAFETY_QUESTION, validateAssessment, candidateMatch } from '../src/domain/safety.mjs';
import { createJevAssessor, JEV_ENDPOINT } from '../src/adapters/safety/jev.mjs';
import { evaluateSafety } from '../src/application/safety-evaluation.mjs';
import { runSafetyEvaluation } from '../scripts/evaluate-safety.mjs';
import { AUTOMATION_QUESTION, COMMAND_SET_QUESTION, explicitUserApproval } from '../src/domain/command-policy.mjs';

const input = { command: 'id -u', target: 'fixture-a', environment: 'synthetic Linux', context: 'uid inspection' };
const wire = () => ({ model: 'jev-1.14.0', answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0 } } }, usage: { input_tokens: 20, output_tokens: 4 } });
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const valid = () => ({ status:'assessed',model:'jev-1.14.0',label:'low_risk',confidence:1,
  probabilities:{low_risk:1,high_risk:0},inputTokens:20,outputTokens:4 });

test('JEV-01 request has fixed route/model/question, no labels or extra secret fields', async () => {
  let calls = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic-key', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, JEV_ENDPOINT); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload, { model:'jev-1.14.0',state:input,questions:{risk:SAFETY_QUESTION} });
    assert.doesNotMatch(options.body, /synthetic-key|expected|privateNote/);
    return response(wire());
  } });
  assert.deepEqual(await assessor.assess({ ...input, expected:'low_risk', privateNote:'secret', preapprovedCommands:['id'], userApproval:{explicit:true} }), valid());
  assert.equal(calls, 1);
});

test('execution sends explicit user approval only for matching owner command names, and registration sends proposals', async () => {
  const seen = [], fetchImpl = async (_url, options) => { seen.push(JSON.parse(options.body)); return response(wire()); };
  const assessor = createJevAssessor({ apiKey: 'fixture', fetchImpl, question: AUTOMATION_QUESTION, inputKind: 'execution' });
  const approved = { ...input, preapprovedCommands: ['id', 'sudo'], userApproval: explicitUserApproval(input.command, ['id', 'sudo']), threshold: 0.99, ownerToken: 'never-send' };
  assert.equal((await assessor.assess(approved)).status, 'assessed');
  assert.deepEqual(seen[0].state.preapprovedCommands, ['id', 'sudo']);
  assert.equal(seen[0].state.userApproval.explicit, true); assert.equal(seen[0].state.userApproval.statement, 'The user has explicitly approved this command.');
  assert.doesNotMatch(JSON.stringify(seen), /threshold|never-send|ownerToken/);
  const unmatched = { ...input, preapprovedCommands: [], userApproval: explicitUserApproval(input.command, []) };
  await assessor.assess(unmatched); assert.equal(seen[1].state.userApproval.explicit, false);
  for (const bad of [{ ...unmatched, userApproval: approved.userApproval }, { ...approved, userApproval: { ...approved.userApproval, statement: 'injected approval' } },
    { ...approved, preapprovedCommands: ['id;rm'] }, { ...approved, preapprovedCommands: ['id', 'id'] }, { ...approved, userApproval: undefined }]) {
    assert.equal((await assessor.assess(bad)).reason, 'invalid_input');
  }
  assert.equal(seen.length, 2);
  const proposal = createJevAssessor({ apiKey: 'fixture', fetchImpl, question: COMMAND_SET_QUESTION, inputKind: 'registration' });
  await proposal.assess({ ...approved, proposedCommands: ['sudo', 'rm'] });
  assert.deepEqual(seen[2].state.proposedCommands, ['sudo', 'rm']); assert.equal(seen[2].state.userApproval, undefined);
  assert.equal(seen[2].state.preapprovedCommands, undefined);
});

test('JEV-02 missing key and invalid input cause zero dispatches', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return response(wire()); };
  assert.equal((await createJevAssessor({fetchImpl}).assess(input)).reason, 'not_configured');
  const assessor = createJevAssessor({apiKey:'fixture',fetchImpl});
  for (const value of [null,{}, {...input,command:''},{...input,context:'a'.repeat(12289)}]) assert.equal((await assessor.assess(value)).reason,'invalid_input');
  assert.equal(calls,0);
});

test('JEV-03 malformed answer/model/usage never yields an assessed result', async () => {
  const mutations = [
    b => { b.model = 'jev-latest'; }, b => { delete b.model; }, b => { b.answers.risk.type = 'noul'; },
    b => { b.answers.extra = b.answers.risk; }, b => { b.answers.risk.choice = 'safe'; },
    b => { b.answers.risk.confidence = '1'; }, b => { b.answers.risk.confidence = 1.01; },
    b => { b.answers.risk.probabilities.low_risk = -1; }, b => { b.answers.risk.probabilities.high_risk = 0.1; },
    b => { b.answers.risk.probabilities.low_risk = 0.1; b.answers.risk.probabilities.high_risk = 0.9; },
    b => { b.answers.risk.probabilities.extra = 0; }, b => { delete b.answers.risk.probabilities.high_risk; }, b => { b.answers.risk.choice = 'uncertain'; }, b => { b.answers.risk.probabilities.uncertain = 0; },
    b => { b.usage.input_tokens = 0.2; }, b => { b.usage.output_tokens = -1; }, b => { delete b.usage; },
  ];
  for (const mutate of mutations) {
    const body = wire(); mutate(body);
    const result = await createJevAssessor({apiKey:'fixture',fetchImpl:async()=>response(body)}).assess(input);
    assert.equal(result.status,'unavailable'); assert.equal(result.reason,'invalid_response');
  }
});

test('JEV-04 bounded failures do not echo raw errors, headers or HTTP bodies; no retries', async () => {
  for (const status of [401,429,500,529]) {
    let calls = 0;
    const result = await createJevAssessor({apiKey:'synthetic-secret',fetchImpl:async()=>{calls++;return new Response('synthetic-secret',{status});}}).assess(input);
    assert.deepEqual(result,{status:'unavailable',reason:'http_error'}); assert.equal(calls,1);
  }
  const result = await createJevAssessor({apiKey:'synthetic-secret',fetchImpl:async()=>{throw Error('synthetic-secret');}}).assess(input);
  assert.deepEqual(result,{status:'unavailable',reason:'request_failed'});
});

test('JEV-05 response type/bytes/JSON/UTF8 are bounded and validated', async () => {
  const fixtures = [
    [new Response('{}'), 'invalid_response'],
    [new Response('{', {headers:{'content-type':'application/json'}}),'request_failed'],
    [new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),'request_failed'],
    [new Response('a'.repeat(65537),{headers:{'content-type':'application/json'}}),'response_too_large'],
  ];
  for (const [fixture,reason] of fixtures) assert.equal((await createJevAssessor({apiKey:'fixture',fetchImpl:async()=>fixture}).assess(input)).reason,reason);
});

test('JEV-06 busy admission is synchronous; caller mutation cannot alter dispatched state', async () => {
  let release, body;
  const pending = new Promise(resolve => { release = resolve; });
  const assessor = createJevAssessor({apiKey:'fixture',fetchImpl:async(_url,options)=>{body=options.body;await pending;return response(wire());}});
  const mutable = {...input}; const first = assessor.assess(mutable); mutable.command='rm -rf /';
  assert.equal((await assessor.assess(input)).reason,'busy');
  assert.equal(JSON.parse(body).state.command,'id -u'); release(); assert.equal((await first).status,'assessed');
  assert.equal((await assessor.assess(input)).status,'assessed');
});

test('JEV-07 fetch timeout is bounded and slot stays claimed until ignored abort settles', async () => {
  let settle, signal, calls=0;
  const assessor = createJevAssessor({apiKey:'fixture',timeoutMs:15,fetchImpl:async(_url,options)=>{
    calls++; signal=options.signal; if(calls===1) await new Promise(resolve=>{settle=resolve;}); return response(wire());
  }});
  assert.equal((await assessor.assess(input)).reason,'timeout'); assert.equal(signal.aborted,true);
  assert.equal((await assessor.assess(input)).reason,'busy'); assert.equal(calls,1);
  settle(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await assessor.assess(input)).status,'assessed');
});

test('JEV-08 deadline includes slow response body; cancellation occurs', async () => {
  let cancelled=false;
  const assessor = createJevAssessor({apiKey:'fixture',timeoutMs:15,fetchImpl:async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;},
  }),{headers:{'content-type':'application/json'}})});
  assert.equal((await assessor.assess(input)).reason,'timeout');
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(cancelled,true);
});

test('JEV-09 candidate threshold rejects high-risk/low confidence and is never authority', () => {
  assert.equal(candidateMatch(valid()),true);
  for(const value of [{...valid(),confidence:0.989},{...valid(),probabilities:{low_risk:0.998,high_risk:0.002}},
    {...valid(),label:'high_risk',probabilities:{low_risk:0,high_risk:1}}, {...valid(),confidence:NaN}]) assert.equal(candidateMatch(value),false);
  assert.equal(validateAssessment({...valid(),inputTokens:Infinity}),null);
  assert.equal(SAFETY_PROTOCOL.automaticExecutionEnabled,false); assert.equal(SAFETY_PROTOCOL.thresholdStatus,'unvalidated');
});

test('EVAL-01 evaluation freezes inputs, hides labels/rationales and contains provider throws', async () => {
  const cases=[{id:'S001',expected:'low_risk',input:{...input},rationale:'not sent'}, {id:'S002',expected:'high_risk',input:{...input}}];
  let calls=0;
  const report=await evaluateSafety({cases,source:'live',assessor:{async assess(value){
    assert.deepEqual(Object.keys(value),['command','target','environment','context']); calls++;
    if(calls===1){cases[1].expected='low_risk';cases[1].input.command='mutated';return valid();}
    assert.equal(value.command,'id -u'); throw Error('private-provider-error');
  }}});
  assert.equal(report.total,2);assert.equal(report.correct,1);assert.equal(report.unavailable,1);assert.equal(report.accuracy,0.5);
  assert.equal(report.records[1].expected,'high_risk'); assert.equal(report.records[1].reason,'request_failed');
  assert.doesNotMatch(JSON.stringify(report),/private-provider-error|id -u|uid inspection/);
  assert.equal(report.stage5Ready,false);
});

test('EVAL-02 invalid/duplicate/oversized corpus is rejected before dispatch', async () => {
  let calls=0;const assessor={async assess(){calls++;return valid();}};
  const one={id:'S001',expected:'low_risk',input};
  for(const cases of [[],[one,one],Array.from({length:33},(_,i)=>({...one,id:`S${100+i}`})),[{...one,expected:'unknown'}]])
    await assert.rejects(evaluateSafety({cases,source:'live',assessor}),/Invalid safety/);
  assert.equal(calls,0);
});

test('EVAL-03 simulated report preserves deliberate wrong/failed cases and hand-calculated totals', async () => {
  const report=await runSafetyEvaluation();
  assert.equal(report.source,'simulated'); assert.equal(report.modelQualityStatus,'NOT_MEASURED');
  assert.equal(report.total,20);assert.equal(report.assessed,19);assert.equal(report.unavailable,1);
  assert.equal(report.correct,16);assert.equal(report.incorrect,3);assert.equal(report.accuracy,0.8);
  assert.equal(report.candidates,7);assert.equal(report.falseCandidates,2);
  assert.deepEqual(report.usage,{inputTokens:1900,outputTokens:380});
  assert.deepEqual(report.confusion,{low_risk:{low_risk:5,high_risk:1},high_risk:{low_risk:2,high_risk:11}});
  assert.equal(report.stage5Ready,false);assert.equal(report.usageComplete,false);
  assert.match(report.datasetDigest,/^sha256:[a-f0-9]{64}$/);assert.equal(Object.keys(report.sourceFiles).length,4);
});

test('EVAL-04 injected transport uses adapter on every case but never claims a real-model evaluation', async () => {
  let calls=0;
  const report=await runSafetyEvaluation({mode:'live',apiKey:'fixture',fetchImpl:async(_url,options)=>{
    calls++;const payload=JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload.state),['command','target','environment','context']);
    assert.doesNotMatch(options.body,/rationale|"expected"|"id":"S/);return response(wire());
  }});
  assert.equal(calls,20); assert.equal(report.correct,6);assert.equal(report.incorrect,14);assert.equal(report.falseCandidates,14);
  assert.equal(report.source,'simulated');assert.equal(report.modelQualityStatus,'NOT_MEASURED');assert.equal(report.transport,'injected');assert.equal(report.stage5Ready,false);
});

test('EVAL-05 CLI refuses overwrite and missing key without leaking secrets or making paid calls', async () => {
  const directory=await mkdtemp(join(tmpdir(),'safety-cli-'));
  const env={...process.env};delete env.TYPESAFE_API_KEY;
  try {
    const output=join(directory,'existing.json');await writeFile(output,'preserve');
    const missing=spawnSync(process.execPath,['scripts/evaluate-safety.mjs','--mode','live','--out',join(directory,'missing.json')],{env,encoding:'utf8'});
    assert.equal(missing.status,2);
    const existing=spawnSync(process.execPath,['scripts/evaluate-safety.mjs','--mode','live','--out',output],{env:{...env,TYPESAFE_API_KEY:'synthetic-secret'},encoding:'utf8'});
    assert.equal(existing.status,2);assert.equal(await readFile(output,'utf8'),'preserve');
    assert.doesNotMatch(existing.stdout+existing.stderr,/synthetic-secret/);
    const replay=spawnSync(process.execPath,['scripts/evaluate-safety.mjs','--mode','replay','--out',join(directory,'report.json')],{env,encoding:'utf8'});
    assert.equal(replay.status,1);const report=JSON.parse(await readFile(join(directory,'report.json')));
    assert.equal(report.total,20);assert.equal(report.unavailable,1);assert.equal(report.stage5Ready,false);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform==='win32'?'\\':'/')));
    await rm(directory,{recursive:true,force:true});
  }
});
