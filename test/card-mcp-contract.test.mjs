import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpAdapter} from '../src/adapters/mcp/server.mjs';
import {createCardController} from '../ui/src/controller.js';
import {createCardState} from '../ui/src/state.js';
import {createCardHost} from '../ui/src/host.js';
const {App}=await import(pathToFileURL(createRequire(new URL('../ui/package.json',import.meta.url)).resolve('@modelcontextprotocol/ext-apps')).href);
const id='a'.repeat(48),revision='b'.repeat(64),outputId='c'.repeat(48);
const config={target:'alpha',direction:'download',remotePath:'/home/fixture/result.txt',elevate:false,overwrite:false};
const active=['accepted','pending','evaluating','queued','starting','running','terminating'];
async function fixture(t){
 const calls=[],submissions=[],observations=[],errors=[],rendered=[],contexts=[],intervals=new Map(),jobs=new Map(),keys=new Map();let lost=false,reject=false,hold,missing=false,serial=0;
 const job={id,kind:'command',operation:{kind:'command',command:'printf fixture'},command:'printf fixture',profile:'alpha-write',commandClass:'read-only',target:'fixture@alpha',targetId:'alpha',targetRevision:revision,state:'queued',createdAt:1,expiresAt:Date.now()+600000};jobs.set(id,job);
 const targets={select:()=>({id:'alpha',revision,platform:'linux',displayName:'Alpha'}),canonicalTransfer:value=>({...value,target:value.target??'alpha'}),list:()=>({targets:[]})};
 const capabilities={guard(){},view:()=>({namespace:'fixture_',uiEnabled:true,targetId:'alpha',targetRevision:revision,approvalTicket:'private-approval',viewTicket:'private-view'}),bootstrap:()=> 'private-bootstrap',verifyJob(){}};
 const operations={
  async submit(input){submissions.push(structuredClone(input));if(reject)throw Object.assign(Error('private rejection detail'),{code:'TARGET_REVISION_CHANGED'});let value=keys.get(input.operationKey);if(!value){value={...job,id:(++serial).toString(16).padStart(48,'0'),kind:'download',operation:{kind:'download',remotePath:input.remotePath,elevate:input.elevate},operationKey:input.operationKey,state:'pending'};keys.set(input.operationKey,value);jobs.set(value.id,value);}return value;},
  async observe(input){observations.push(structuredClone(input));if(hold)await hold;const value=input.id?jobs.get(input.id):keys.get(input.operationKey);if(missing||!value)throw Object.assign(Error('private missing detail'),{code:'OPERATION_NOT_FOUND'});return value;},
 };
 const server=createMcpAdapter({queue:{get:value=>missing?undefined:jobs.get(value)},files:{},settings:{uiEnabled:true,prefix:'fixture_',maxBytes:64},capabilities,targets,operations,uiHtml:'<html>fixture</html>',shutdownSignal:new AbortController().signal,commandOutputs:{read:()=>({outputId,bytes:7,nextOffset:7,eof:true,text:'PRIVATE_OUTPUT_BODY'})}})();
 const client=new Client({name:'card-contract',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 t.after(async()=>{await client.close();await server.close();});
 t.mock.method(App.prototype,'callServerTool',async({name,arguments:args})=>{assert.ok(name.startsWith('fixture_'));name=name.slice('fixture_'.length);calls.push({name,args:structuredClone(args)});if(name==='show-approval'&&hold)await hold;const result=await client.callTool({name,arguments:args});if(name==='submit'&&lost){lost=false;throw Error('synthetic response lost');}return result;});
 const host=createCardHost(s=>s);host.updateModelContext=async value=>{contexts.push(value);return {};};
 const state=createCardState(),view={t:s=>s,clear(){},error:s=>{if(s)errors.push(s);},setBusy(){},job:(value,meta)=>rendered.push({job:value,meta}),transfer(){},missing(){errors.push('missing');},output:(text,metadata)=>rendered.push({text,metadata})};
 const timers={setInterval(fn){const key=intervals.size+1;intervals.set(key,fn);return key;},clearInterval(key){intervals.delete(key);}};
 const controller=createCardController({state,view,host,document:{hidden:false},timers});
 const receiveJob=async()=>controller.receive(await client.callTool({name:'show-approval',arguments:{id}}));
 const receiveTransfer=async()=>controller.receive(await client.callTool({name:'show-file-transfer',arguments:config}));
 return {client,controller,state,job,calls,submissions,observations,errors,rendered,contexts,intervals,jobs,receiveJob,receiveTransfer,loseReply(){lost=true;},reject(){reject=true;},missing(){missing=true;},hold(value){hold=value;}};
}

test('card polls the actual MCP presentation once per refresh and renews private tickets without output reads',async t=>{
 const f=await fixture(t);await f.receiveJob();
 for(const state of active){f.job.state=state;await f.controller.refresh();assert.equal(f.state.job.state,state);assert.equal(f.intervals.size,1,state+' must keep polling');}
 f.job.state='completed';await f.controller.refresh();
 assert.equal(f.state.job.state,'completed');assert.equal(f.intervals.size,0);assert.equal(f.state.meta.viewTicket,'private-view');
 assert.equal(f.calls.length,active.length+1);assert.ok(f.calls.every(c=>c.name==='show-approval'&&c.args.id===id));assert.equal(f.observations.length,0);
 assert.doesNotMatch(JSON.stringify(f.contexts),/private-view|private-approval|PRIVATE_OUTPUT_BODY/);
});

test('missing card preserves the actual MCP refusal without inventing a terminal state or resubmitting',async t=>{
 const f=await fixture(t);await f.receiveJob();f.missing();await assert.rejects(f.controller.refresh(),/요청이 거부/);
 assert.equal(f.state.job.state,'queued');assert.deepEqual(f.errors,[]);assert.equal(f.submissions.length,0);assert.deepEqual(f.calls.map(c=>c.name),['show-approval']);
});

test('download card submits current MCP fields with a stable key and pinned target revision, then loads the private card',async t=>{
 const f=await fixture(t);await f.receiveTransfer();await f.controller.submit(config,null,f.state.capture());
 assert.deepEqual(f.errors,[]);assert.equal(f.submissions.length,1);const input=f.submissions[0];
 assert.equal(input.kind,'download');assert.match(input.operationKey,/^[A-Za-z0-9_.:-]{16,128}$/);assert.equal(input.target,'alpha');assert.equal(input.expectedTargetRevision,revision);
 assert.equal(input.remotePath,config.remotePath);assert.equal(input.elevate,false);assert.deepEqual(Object.keys(input).sort(),['elevate','expectedTargetRevision','kind','operationKey','remotePath','target']);
 assert.equal(f.state.mode,'job');assert.equal(f.state.job.id,[...f.jobs.keys()].at(-1));assert.equal(f.state.meta.approvalTicket,'private-approval');
 assert.deepEqual(f.calls.map(c=>c.name),['submit','show-approval']);
});

test('lost download reply recovers the original key with observe and never creates a second submission',async t=>{
 const f=await fixture(t);await f.receiveTransfer();const context=f.state.capture();f.loseReply();await f.controller.submit(config,null,context);
 assert.equal(f.submissions.length,1);assert.equal(f.state.mode,'transfer');await f.controller.submit(config,null,context);
 assert.equal(f.submissions.length,1);assert.equal(f.observations.at(-1).operationKey,f.submissions[0].operationKey);assert.equal(f.state.mode,'job');
 assert.deepEqual(f.calls.map(c=>c.name),['submit','observe','show-approval']);
});

test('uncertain download intent cannot change path or target under its existing operation key',async t=>{
 const f=await fixture(t);await f.receiveTransfer();const context=f.state.capture();f.loseReply();await f.controller.submit(config,null,context);
 for(const change of [{remotePath:'/home/fixture/other.txt'},{target:'beta'},{elevate:true}])await f.controller.submit({...config,...change},null,context);
 assert.equal(f.submissions.length,1);assert.equal(f.observations.length,0);assert.equal(f.state.mode,'transfer');
 await f.controller.submit(config,null,context);assert.equal(f.state.mode,'job');assert.equal(f.submissions.length,1);
});

test('download refuses a card without a pinned revision before sending any operation',async t=>{
 const f=await fixture(t);await f.receiveTransfer();delete f.state.meta.targetRevision;await f.controller.submit(config,null,f.state.capture());
 assert.equal(f.submissions.length,0);assert.equal(f.state.mode,'transfer');assert.equal(f.errors.length,1);
});

test('typed submit rejection is not mistaken for an accepted ID or a new rendered job',async t=>{
 const f=await fixture(t);await f.receiveTransfer();f.reject();await f.controller.submit(config,null,f.state.capture());
 assert.equal(f.submissions.length,1);assert.equal(f.state.mode,'transfer');assert.equal(f.errors.length,1);assert.doesNotMatch(f.errors[0],/private rejection/);assert.deepEqual(f.calls.map(c=>c.name),['submit']);
});

test('late presentation cannot replace another card',async t=>{
 const f=await fixture(t);await f.receiveJob();let release;f.hold(new Promise(done=>release=done));const refresh=f.controller.refresh().catch(error=>error);
 while(f.calls.length===0)await new Promise(done=>setImmediate(done));await f.receiveTransfer();release();assert.equal(await refresh,undefined);
 assert.equal(f.state.mode,'transfer');assert.deepEqual(f.calls.map(c=>c.name),['show-approval']);assert.equal(f.submissions.length,0);
});
