import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createAgentReleaseCatalog} from '../src/adapters/releases/agent-cli.mjs';

const integrity='sha512-'+Buffer.alloc(64,7).toString('base64');
function metadata(provider='codex',version='1.2.3') {
 const name=provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code';
 return {name,version,dist:{tarball:'https://registry.npmjs.org/'+name+'/-/'+name.split('/')[1]+'-'+version+'.tgz',integrity},private:'SYNTHETIC_PRIVATE_FIELD'};
}
const oversized=Buffer.from(JSON.stringify({...metadata(),private:'x'.repeat(256*1024)}));
function harness(responses=[{}]) {
 const calls=[];
 const request=(url,options,callback)=>{
  const spec=responses.shift()??{},req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true;};
  calls.push({url,options,req});
  queueMicrotask(()=>{
   if(spec.requestError){req.emit('error',Error('SYNTHETIC_PRIVATE_ERROR'));return;}
   if(spec.never)return;
   const res=new Readable({read(){}});res.statusCode=spec.status??200;res.headers=spec.headers??{'content-type':'application/json'};
   callback(res);
   if(spec.responseError){res.destroy(Error('SYNTHETIC_PRIVATE_ERROR'));return;}
   if(spec.aborted){res.emit('aborted');return;}
   for(const chunk of spec.chunks??[Buffer.from(spec.body??JSON.stringify(spec.metadata??metadata()))])res.push(chunk);
   if(spec.beforeEnd)spec.beforeEnd();
   res.push(null);
  });
  return req;
 };
 return {calls,request};
}

test('fixed provider URL and credential-free TLS request; public immutable plan only',async()=>{
 for(const [provider,url] of [['codex','https://registry.npmjs.org/@openai%2Fcodex/latest'],['claude','https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest']]){
  const h=harness([{metadata:metadata(provider)}]),catalog=createAgentReleaseCatalog({request:h.request,now:()=>1000});
  const plan=await catalog.get(provider),request=h.calls[0];
  assert.equal(request.url,url);assert.equal(h.calls.length,1);assert.equal(request.options.agent,false);assert.equal(request.options.rejectUnauthorized,true);assert.equal(request.options.maxHeaderSize,16384);
  assert.deepEqual(request.options.headers,{accept:'application/json','accept-encoding':'identity'});
  assert.equal(plan.release.provider,provider);assert.equal(plan.release.version,'1.2.3');assert.equal(plan.fetchedAt,1000);assert.equal(plan.expiresAt,301000);
  assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.release));assert.ok(!JSON.stringify(plan).includes('SYNTHETIC_PRIVATE_FIELD'));
  assert.deepEqual(Object.keys(plan).sort(),['expiresAt','fetchedAt','release']);
 }
});
test('unsupported providers are refused before any request',async()=>{
 const h=harness(),catalog=createAgentReleaseCatalog({request:h.request});
 for(const provider of ['constructor','__proto__','https://other.example','CODEX',null])await assert.rejects(()=>catalog.get(provider));
 assert.equal(h.calls.length,0);
});
for(const [name,spec] of [
 ['redirect',{status:302,headers:{location:'https://other.example'}}],
 ['unauthenticated',{status:401}],['not found',{status:404}],
 ['wrong content type',{headers:{'content-type':'text/html'}}],
 ['compressed body',{headers:{'content-type':'application/json','content-encoding':'gzip'}}],
 ['oversized body',{chunks:[oversized.subarray(0,128*1024),oversized.subarray(128*1024)]}],
 ['invalid UTF8',{chunks:[Buffer.from([0xff])]}],['invalid JSON',{body:'not JSON'}],
 ['wrong package',{metadata:{...metadata(),name:'arbitrary'}}],
 ['wrong tarball',{metadata:{...metadata(),dist:{...metadata().dist,tarball:'https://other.example/payload.tgz'}}}],
 ['invalid integrity',{metadata:{...metadata(),dist:{...metadata().dist,integrity:'sha512-YQ=='}}}],
 ['request error',{requestError:true}],['response error',{responseError:true}],['aborted response',{aborted:true}],
])test(name+' produces one bounded generic failure',async()=>{
 const h=harness([spec]),catalog=createAgentReleaseCatalog({request:h.request});
 await assert.rejects(()=>catalog.get('codex'),/^Error: CLI release unavailable$/);assert.equal(h.calls.length,1);
});
test('an overall request deadline destroys the owned request and does not retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=harness([{never:true}]),catalog=createAgentReleaseCatalog({request:h.request});
 const rejected=assert.rejects(catalog.get('codex'),/^Error: CLI release unavailable$/);t.mock.timers.tick(10000);await rejected;
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].req.destroyed,true);
});
test('same-provider concurrent reads share one request and a valid cache entry',async()=>{
 const h=harness(),catalog=createAgentReleaseCatalog({request:h.request,now:()=>1000});
 const [a,b]=await Promise.all([catalog.get('codex'),catalog.get('codex')]);assert.equal(h.calls.length,1);assert.strictEqual(a,b);
 assert.strictEqual(await catalog.get('codex'),a);assert.equal(h.calls.length,1);
});
test('exact cache expiry refreshes metadata and never uses stale results on failure',async()=>{
 let now=1000;const h=harness([{}, {status:503},{metadata:metadata('codex','1.2.4')}]),catalog=createAgentReleaseCatalog({request:h.request,now:()=>now});
 const first=await catalog.get('codex');now=first.expiresAt-1;assert.strictEqual(await catalog.get('codex'),first);
 now=first.expiresAt;await assert.rejects(()=>catalog.get('codex'));assert.equal(h.calls.length,2);
 const next=await catalog.get('codex');assert.equal(next.release.version,'1.2.4');assert.equal(h.calls.length,3);
});
test('late success after plan lifetime never becomes an installable plan',async()=>{
 let now=1000;const h=harness([{beforeEnd:()=>{now=301000;}}]),catalog=createAgentReleaseCatalog({request:h.request,now:()=>now});
 await assert.rejects(()=>catalog.get('codex'));assert.equal(h.calls.length,1);
});
test('invalid clock and synchronous transport exceptions are refused without private errors',async()=>{
 const h=harness(),catalog=createAgentReleaseCatalog({request:h.request,now:()=>NaN});await assert.rejects(()=>catalog.get('codex'));assert.equal(h.calls.length,0);
 const broken=createAgentReleaseCatalog({request:()=>{throw Error('SYNTHETIC_PRIVATE_ERROR');}});
 await assert.rejects(()=>broken.get('codex'),/^Error: CLI release unavailable$/);
});
