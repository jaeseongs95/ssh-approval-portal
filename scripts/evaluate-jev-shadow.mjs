#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JEV_ENDPOINT } from '../src/adapters/safety/jev.mjs';
import { buildShadowPlan, parseShadowResponse, shadowDecision, digest } from './jev-shadow-protocol.mjs';
const fixtures={questions:'jev-shadow-corpus.json','input-factor':'jev-input-factor-corpus.json'};

/** Fixed HTTPS endpoint, sequential bounded calls, no retries. Never executes commands. */
export async function runJevShadow({mode='prepare',apiKey,fetchImpl=globalThis.fetch,timeoutMs=10000,profile='questions'}={}) {
  if (!Object.hasOwn(fixtures,profile)) throw Error('Invalid shadow profile');
  if (!['prepare','live'].includes(mode) || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000) throw Error('Invalid shadow mode');
  const bytes=await readFile(new URL('../test/fixtures/'+fixtures[profile],import.meta.url));
  const plan=buildShadowPlan(JSON.parse(bytes),{profile});
  const report={schemaVersion:'1.0.0',qualification:'synthetic-diagnostic-only',executionAuthority:false,
    modelQualityStatus:'NOT_MEASURED',humanBurdenStatus:'NOT_MEASURED',mode,
    transport:mode==='prepare'?'none':fetchImpl===globalThis.fetch?'typesafe-https':'injected',
    model:plan.model,corpusDigest:digest(bytes),planDigest:digest(JSON.stringify(plan)),plannedCalls:plan.cells.length,
    recordedCalls:0,unattemptedCalls:plan.cells.length,unavailable:0,records:[],limitations:['Draft synthetic oracle is not independent quality evidence.',
      'No live jobs, source files, policy or credentials are read from servers.',
      'New question scores do not inherit existing thresholds or execution authority.',
      'No workload-matched human effort or calibrated safety measured.']};
  if(mode==='prepare') return {...report,plan};
  if(typeof apiKey!=='string'||!apiKey.trim()) throw Error('Key required');
  for(const cell of plan.cells) {
    const controller=new AbortController();let timer,reader;
    const call=(async()=>{
      try {
        const response=await fetchImpl(JEV_ENDPOINT,{method:'POST',redirect:'error',signal:controller.signal,
          headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(cell.body)});
        if(controller.signal.aborted) {void response.body?.cancel().catch(()=>{});return {reason:'timeout'};}
        if(!response.ok) {void response.body?.cancel().catch(()=>{});return {reason:'http_error',httpStatus:response.status};}
        if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) return {reason:'invalid_response'};
        reader=response.body?.getReader();if(!reader)return {reason:'invalid_response'};
        const chunks=[];let size=0;
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)return {reason:'response_too_large'};chunks.push(value);}
        const assessment=parseShadowResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),cell);
        return assessment?shadowDecision(cell,assessment):{reason:'invalid_response'};
      } catch{return {reason:controller.signal.aborted?'timeout':'request_failed'};}
      finally {if(reader)void reader.cancel().catch(()=>{});}
    })();
    let result;
    try {result=await Promise.race([call,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();if(reader)void reader.cancel().catch(()=>{});resolve({reason:'timeout'});},timeoutMs);})]);}
    finally {clearTimeout(timer);controller.abort();}
    report.recordedCalls++;
    report.unattemptedCalls--;
    if(result.reason)report.unavailable++;
    report.records.push({id:cell.id,family:cell.family,q:cell.q,s:cell.s,f:cell.f,wireDigest:cell.wireDigest,...result});
    // A timed-out transport may still be in flight. Stop the run, never overlap or retry it.
    if(result.reason==='timeout'||[401,403,429].includes(result.httpStatus))break;
  }
  return report;
}

export async function main(argv=process.argv.slice(2)) {
  if(![4,6].includes(argv.length)||argv[0]!=='--mode'||!['prepare','live'].includes(argv[1])||argv[2]!=='--out'||!argv[3]
    ||argv.length===6&&(argv[4]!=='--profile'||!Object.hasOwn(fixtures,argv[5]))) {
    console.error('Usage: node scripts/evaluate-jev-shadow.mjs --mode prepare|live --out NEW_REPORT.json [--profile questions|input-factor]');return 2;
  }
  let file;
  try {
    if(argv[1]==='live'&&!process.env.TYPESAFE_API_KEY)throw Error('Missing key');
    file=await open(resolve(argv[3]),'wx',0o600);
    const report=await runJevShadow({mode:argv[1],apiKey:process.env.TYPESAFE_API_KEY,profile:argv[5]??'questions'});
    await file.writeFile(JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({mode:report.mode,plannedCalls:report.plannedCalls,recordedCalls:report.recordedCalls,unattemptedCalls:report.unattemptedCalls,unavailable:report.unavailable,executionAuthority:false}));
    return report.unavailable?1:0;
  } catch {
    if(file)await file.writeFile('{"status":"failed","executionAuthority":false}\n').catch(()=>{});
    console.error('Shadow evaluation failed. Check mode, key presence and a new output path.');return 2;
  } finally {await file?.close();}
}
if(import.meta.main)process.exitCode=await main();
