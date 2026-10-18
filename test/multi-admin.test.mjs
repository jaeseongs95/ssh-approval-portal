import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createApplication} from '../app.mjs';
import {createTargetRouter} from '../src/application/target-router.mjs';
import {classifyCommand} from 'ssh-mcp/build/policy/classifier.js';

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),'ssh-multi-admin-'));
  const targets=['alpha','beta'].map(id=>({id,displayName:'같은 이름',readProfile:id+'-read',writeProfile:id+'-write',credentialRevision:'v1'}));
  const env={BRIDGE_MCP_TOKEN:'isolated-mcp',BRIDGE_ADMIN_TOKEN:'isolated-owner',BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_COMMAND_AUTOMATION:'true'};
  let app,origin,executions=0;
  const open=async list=>{
    await app?.close();
    app=await createApplication({env:{...env,BRIDGE_TARGETS:JSON.stringify(list)},registry:{getProfile:name=>({host:'127.0.0.1',port:name.startsWith('alpha')?22:23,user:'synthetic',trustedHostKey:'SHA256:'+name.split('-')[0],readOnly:name.endsWith('-read')}),closeAll:async()=>{}},classify:classifyCommand,executeCommand:async()=>{executions++;return{failed:false,texts:['synthetic']};},audit:()=>{},transferRoot:root,uiHtml:'<html></html>'});
    await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+app.adminHttp.address().port;
  };
  const api=async(path,body)=>{const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer isolated-owner',Origin:env.BRIDGE_ADMIN_ORIGIN,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  const proposal=snapshot=>({expectedRevision:snapshot.revision,policy:{targets:structuredClone(snapshot.targets)}});
  const save=async candidate=>{const review=await api('/api/command-policy/review',candidate);assert.equal(review.status,200);return api('/api/command-policy',{...candidate,reviewToken:review.body.reviewToken,acknowledged:true});};
  try {
    await open(targets);
    const initial=(await api('/api/command-policy')).body;
    const candidate={expectedRevision:initial.revision,policy:{targets:initial.bindings.map(({targetId,targetRevision,profile})=>({targetId,targetRevision,profile,commands:['id'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}))}};
    assert.equal((await save(candidate)).status,200);
    await run({targets,open,api,proposal,save,get app(){return app;},get executions(){return executions;}});
  } finally {
    await app?.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('ssh-multi-admin-'));await rm(root,{recursive:true,force:true});
  }
}

for(const variant of ['disabled','stale','removed'])test('unchanged '+variant+' rule survives another target review/save, with CAS and exact digest',()=>fixture(async f=>{
  const list=variant==='removed'?f.targets.filter(t=>t.id!=='alpha'):f.targets.map(t=>t.id==='alpha'?{...t,...(variant==='disabled'?{enabled:false}:{credentialRevision:'v2'})}:t);
  await f.open(list);
  const before=(await f.api('/api/command-policy')).body,candidate=f.proposal(before);
  // Object property order is not an authority change.
  candidate.policy.targets[0]=Object.fromEntries(Object.entries(candidate.policy.targets[0]).reverse());
  candidate.policy.targets.find(t=>t.targetId==='beta').commands.push('pwd');
  const review=await f.api('/api/command-policy/review',candidate);assert.equal(review.status,200);
  const changed=structuredClone(candidate);changed.policy.targets.find(t=>t.targetId==='beta').commands.push('ls');
  assert.equal((await f.api('/api/command-policy',{...changed,reviewToken:review.body.reviewToken,acknowledged:true})).status,409);
  assert.equal((await f.api('/api/command-policy',{...candidate,reviewToken:review.body.reviewToken,acknowledged:true})).status,200);
  const after=(await f.api('/api/command-policy')).body;
  assert.deepEqual(after.targets.find(t=>t.targetId==='alpha'),before.targets.find(t=>t.targetId==='alpha'));
  assert.equal((await f.api('/api/command-policy/review',candidate)).status,409,'whole-policy CAS still rejects stale writer');
  const invalid=f.proposal(after);invalid.policy.targets.find(t=>t.targetId==='alpha').commands.push('ls');
  assert.equal((await f.api('/api/command-policy/review',invalid)).status,409,'changed invalid binding denied');
  const flag=f.proposal(after);flag.policy.targets.find(t=>t.targetId==='alpha').automaticSudo=false;
  assert.equal((await f.api('/api/command-policy/review',flag)).status,409,'missing and explicit false are not normalized into equal rules');
  for(const key of ['targetRevision','profile']){
    const bad=f.proposal(after);bad.policy.targets.find(t=>t.targetId==='beta')[key]=key==='profile'?'wrong':'f'.repeat(64);
    assert.equal((await f.api('/api/command-policy/review',bad)).status,409);
  }
  assert.equal(f.executions,0);
  // Deletion also remains an exact reviewed proposal, never a hot target update.
  const deletion=f.proposal(after);deletion.policy.targets=deletion.policy.targets.filter(t=>t.targetId!=='alpha');
  assert.equal((await f.save(deletion)).status,200);
  assert.deepEqual((await f.api('/api/command-policy')).body.targets.map(t=>t.targetId),['beta']);
}));

test('disable suspends the target; identical re-enable restores the same binding and existing policy',()=>fixture(async f=>{
  const before=(await f.api('/api/command-policy')).body;
  await f.open(f.targets.map(t=>({...t,enabled:t.id!=='alpha'})));
  assert.throws(()=>f.app.targets.select('alpha'));
  await f.open(f.targets);
  const after=(await f.api('/api/command-policy')).body;
  assert.deepEqual(after.targets,before.targets);assert.equal(after.bindings[0].targetRevision,before.bindings[0].targetRevision);
  assert.equal(f.app.targets.select('alpha').enabled,true);assert.equal(f.executions,0);
}));

test('stored output rechecks current activation/revision without repeating SSH execution',()=>fixture(async f=>{
  const output=(await f.app.targets.commands.read('id','alpha')).output;
  assert.equal(output.state,'ready');assert.equal((await f.api('/api/outputs/'+output.id+'?offset=0')).status,200);
  await f.open(f.targets.map(t=>({...t,enabled:t.id!=='alpha'})));
  assert.equal((await f.api('/api/outputs/'+output.id+'?offset=0')).status,409);assert.equal(f.executions,1);
  await f.open(f.targets);assert.equal((await f.api('/api/outputs/'+output.id+'?offset=0')).status,200);
  await f.open(f.targets.map(t=>t.id==='alpha'?{...t,credentialRevision:'v2'}:t));
  assert.equal((await f.api('/api/outputs/'+output.id+'?offset=0')).status,409);assert.equal(f.executions,1);
}));

test('ambiguous request ownership refuses all routing without calling either target',()=>{
  let called=0;
  const runtimes=['alpha','beta'].map(id=>({id,enabled:true,queue:{jobs:new Map([['duplicate',{}]]),get:()=>++called,subject:()=>++called,approve:()=>++called,deny:()=>++called,start:()=>++called,wait:()=>++called}}));
  const router=createTargetRouter(runtimes,{defaultTarget:'alpha',legacy:false,store:{},audit:()=>{}});
  for(const action of ['get','subject','approve','deny','start','wait'])assert.throws(()=>router.queue[action]('duplicate'),/Ambiguous request/);
  assert.equal(called,0);runtimes[1].queue.jobs.delete('duplicate');assert.equal(router.jobOwner('duplicate').id,'alpha');assert.throws(()=>router.jobOwner('missing'),/Unknown request/);
});
