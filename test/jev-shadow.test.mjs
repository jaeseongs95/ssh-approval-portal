import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildShadowPlan, parseShadowResponse, shadowDecision, SHADOW_MODEL } from '../scripts/jev-shadow-protocol.mjs';
import { runJevShadow } from '../scripts/evaluate-jev-shadow.mjs';
const corpus=JSON.parse(await readFile(new URL('./fixtures/jev-shadow-corpus.json',import.meta.url)));
const plan=()=>buildShadowPlan(structuredClone(corpus));
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
// Test-owned response contract, not imported from the implementation encoder.
const wire=(body,positive=0.9)=>({model:'jev-1.14.0',answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>{
  const labels=Object.keys(q.criteria);return [key,{type:'choice',choice:labels[0],confidence:0.01,
    probabilities:{[labels[0]]:positive,[labels[1]]:(1-positive)/2,[labels[2]]:(1-positive)/2}}];
})),usage:{input_tokens:40,output_tokens:10}});

test('SHADOW-01 eight paired cells preserve exact command, provenance and facts across representations',()=>{
  const p=plan();assert.equal(p.cells.length,8);assert.equal(p.model,SHADOW_MODEL);
  assert.equal(new Set(p.cells.map(x=>x.id)).size,8);
  for(const f of ['F0','F1']){
    const a=p.cells.find(c=>c.q==='Q0'&&c.s==='S0'&&c.f===f),b=p.cells.find(c=>c.q==='Q0'&&c.s==='S1'&&c.f===f);
    assert.deepEqual(JSON.parse(a.body.state.context),b.body.state.context);
    assert.equal(a.body.state.command,'python3 -I -B /fixture/collect.py');
    assert.equal(b.body.state.command,a.body.state.command);
    assert.equal(b.body.questions.risk.instructions,a.body.questions.risk.instructions);
  }
  const f0=p.cells[1].body.state.context,f1=p.cells[3].body.state.context;
  assert.deepEqual(f0.verifiedFacts,f1.verifiedFacts);assert.deepEqual(f0.callerClaims,f1.callerClaims);
  assert.equal(f0.artifacts[0].source,undefined);assert.equal(f1.artifacts[0].source,corpus.cases[0].artifact.source);
  assert.equal(f0.artifacts[0].sha256,f1.artifacts[0].sha256);
  assert.match(f0.provenance,/not actual server/);
  assert.equal(p.cells[0].oracle,'unknown');assert.equal(p.cells[3].oracle,'within');
});

test('SHADOW-02 changed artifact bytes cannot retain the old digest',()=>{
  const c=structuredClone(corpus);c.cases[0].artifact.source+='\nprint("changed")';
  assert.throws(()=>buildShadowPlan(c),/Invalid artifact binding/);
});

test('SHADOW-03 malformed/duplicate/non-synthetic corpus is rejected without input mutation',()=>{
  const original=JSON.stringify(corpus);buildShadowPlan(corpus);assert.equal(JSON.stringify(corpus),original);
  for(const change of [c=>c.syntheticOnly=false,c=>c.cases.push(c.cases[0]),c=>c.cases=[],
    c=>c.cases[0].artifact.path='/real/secrets.py',c=>c.cases[0].artifact.path='/fixture/../secret.py',c=>c.cases[0].artifact.coverage='verified-safe']){
    const c=structuredClone(corpus);change(c);assert.throws(()=>buildShadowPlan(c));
  }
});

test('SHADOW-04 wire never includes draft oracle and each question is self-contained',()=>{
  for(const c of plan().cells){
    assert.doesNotMatch(JSON.stringify(c.body),/"oracle"|diagnostic-draft-oracle|"family"/);
    assert.deepEqual(Object.keys(c.body),['model','state','questions']);
    if(c.q==='Q2'){
      assert.deepEqual(Object.keys(c.body.questions),['mutation','disclosure','resources']);
      for(const q of Object.values(c.body.questions))assert.deepEqual(Object.keys(q.criteria),['established','violated','not_established']);
    }
  }
});

test('SHADOW-05 current .51/.80 use p(low_risk); new questions never inherit those gates',()=>{
  const [v4,,, ,q1,,,q2]=plan().cells;
  const a=shadowDecision(v4,parseShadowResponse(wire(v4.body,0.79),v4));
  assert.deepEqual(a.operatingPoints,{'0.51':true,'0.80':false});assert.equal(a.executionAuthority,false);
  const b=shadowDecision(v4,parseShadowResponse(wire(v4.body,0.8),v4));assert.equal(b.operatingPoints['0.80'],true);
  for(const cell of [q1,q2]){
    const d=shadowDecision(cell,parseShadowResponse(wire(cell.body),cell));
    assert.equal(d.operatingPoints,null);assert.equal(d.thresholdStatus,'unvalidated-new-contract');assert.equal(d.executionAuthority,false);
  }
});

test('SHADOW-06 response schema, pinned model, probability distribution and winning label are checked',()=>{
  const cell=plan().cells[0];
  for(const change of [r=>r.model='jev-1.13.0',r=>delete r.answers.risk,r=>r.answers.other={},
    r=>r.answers.risk.choice='unknown',r=>r.answers.risk.type='noul',r=>r.answers.risk.confidence=NaN,
    r=>r.answers.risk.probabilities.low_risk=0.2,r=>r.answers.risk.choice='high_risk',
    r=>r.answers.risk.probabilities.extra=0,r=>r.usage.input_tokens=-1]){
    const raw=wire(cell.body);change(raw);assert.equal(parseShadowResponse(raw,cell),null);
  }
  const raw=wire(cell.body);raw.private='must-not-persist';raw.answers.risk.reason='private-reason';
  assert.doesNotMatch(JSON.stringify(parseShadowResponse(raw,cell)),/must-not-persist|private-reason/);
  const atomic=plan().cells.at(-1),missing=wire(atomic.body);delete missing.answers.resources;
  assert.equal(parseShadowResponse(missing,atomic),null);
});

test('SHADOW-07 prepare has no transport calls; injected replies exercise all cells without model-quality claims',async()=>{
  let calls=0;const expected=plan();
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.deepEqual(body,expected.cells[calls++].body);return json(wire(body));
  };
  const prepared=await runJevShadow({fetchImpl});assert.equal(calls,0);assert.equal(prepared.plannedCalls,8);
  const report=await runJevShadow({mode:'live',apiKey:'synthetic-key',fetchImpl});
  assert.equal(calls,8);assert.equal(report.records.length,8);assert.equal(report.unavailable,0);
  assert.equal(report.modelQualityStatus,'NOT_MEASURED');assert.equal(report.humanBurdenStatus,'NOT_MEASURED');
  assert.equal(report.transport,'injected');assert.equal(report.executionAuthority,false);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-key|python3 -I|import json/);
});

test('SHADOW-08 timeout stops all subsequent cells even when a transport ignores abort',async()=>{
  let calls=0,settle,signal;
  const report=await runJevShadow({mode:'live',apiKey:'synthetic',timeoutMs:10,fetchImpl:async(_url,options)=>{
    calls++;signal=options.signal;await new Promise(r=>{settle=r;});return json(wire(JSON.parse(options.body)));
  }});
  assert.equal(calls,1);assert.equal(signal.aborted,true);assert.equal(report.records.length,1);
  assert.equal(report.records[0].reason,'timeout');assert.equal(report.unavailable,1);
  settle();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});

test('SHADOW-09 streamed size, malformed bytes, HTTP and provider errors cannot become valid answers',async()=>{
  for(const make of [()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),
    ()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),
    ()=>new Response('{}'),()=>new Response('private',{status:403}),()=>{throw Error('private-provider-error');}]){
    const report=await runJevShadow({mode:'live',apiKey:'private-key',fetchImpl:async()=>make()});
    assert.ok(report.unavailable>0);assert.ok(report.records.every(x=>!x.answers));
    assert.doesNotMatch(JSON.stringify(report),/private-key|private-provider-error/);
  }
});

test('SHADOW-10 CLI refuses overwrite/missing key and saves a prepare artifact without a key',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-shadow-')),env={...process.env};delete env.TYPESAFE_API_KEY;
  try {
    const existing=join(dir,'existing.json');await writeFile(existing,'preserve');
    const result=spawnSync(process.execPath,['scripts/evaluate-jev-shadow.mjs','--mode','prepare','--out',existing],{env,encoding:'utf8'});
    assert.equal(result.status,2);assert.equal(await readFile(existing,'utf8'),'preserve');
    const missing=spawnSync(process.execPath,['scripts/evaluate-jev-shadow.mjs','--mode','live','--out',join(dir,'missing.json')],{env,encoding:'utf8'});
    assert.equal(missing.status,2);
    const output=join(dir,'plan.json');const prepared=spawnSync(process.execPath,['scripts/evaluate-jev-shadow.mjs','--mode','prepare','--out',output],{env,encoding:'utf8'});
    assert.equal(prepared.status,0);const report=JSON.parse(await readFile(output));assert.equal(report.plannedCalls,8);
    assert.equal(report.recordedCalls,0);assert.equal(report.unattemptedCalls,8);assert.equal(report.plan.cells.length,8);
  } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));await rm(dir,{recursive:true,force:true});}
});

test('SHADOW-11 partial source coverage remains explicit and one violated atomic obligation is not averaged away',()=>{
  const c=structuredClone(corpus);c.cases[0].artifact.coverage='partial';c.cases[0].oracle='unknown';
  const cell=buildShadowPlan(c).cells.at(-1);
  assert.ok(cell.body.state.context.materialUnknowns.includes('Effect-bearing helper code is missing.'));
  const raw=wire(cell.body);raw.answers.disclosure={type:'choice',choice:'violated',confidence:1,
    probabilities:{established:0,violated:1,not_established:0}};
  const d=shadowDecision(cell,parseShadowResponse(raw,cell));assert.equal(d.allPositive,false);assert.equal(d.score,0);
  assert.equal(d.operatingPoints,null);assert.equal(d.executionAuthority,false);
});

test('SHADOW-12 timeout covers stalled body; auth and rate rejection leave remaining cells unattempted',async()=>{
  let cancelled=false;
  const stalled=await runJevShadow({mode:'live',apiKey:'fixture',timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}
  }),{headers:{'content-type':'application/json'}})});
  assert.equal(stalled.records[0].reason,'timeout');assert.equal(stalled.unattemptedCalls,7);assert.equal(cancelled,true);
  for(const status of [401,403,429]){
    let calls=0;const r=await runJevShadow({mode:'live',apiKey:'fixture',fetchImpl:async()=>{calls++;return new Response('{}',{status});}});
    assert.equal(calls,1);assert.equal(r.recordedCalls,1);assert.equal(r.unattemptedCalls,7);assert.equal(r.records[0].httpStatus,status);
  }
});
