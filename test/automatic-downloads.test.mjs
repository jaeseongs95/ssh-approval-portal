import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../app.mjs';
import {validateCommandPolicy} from '../src/domain/command-policy.mjs';

async function fixture(run, {automation = true, failAudit = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'download-policy-')), effects = [], profiles = new Map(); let app;
  const entries = ['alpha','beta'].map(id => ({id, displayName:id, readProfile:id+'-read', writeProfile:id+'-write', credentialRevision:'v1'}));
  for (const e of entries) for (const name of [e.readProfile,e.writeProfile]) profiles.set(name,{host:e.id+'.test',user:'fixture',port:22,trustedHostKey:'SHA256:'+e.id,readOnly:name.endsWith('-read')});
  try {
    app = await createApplication({secretResolver:{resolve:async()=> '1'.repeat(64)},registry:{getProfile:n=>profiles.get(n),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>assert.fail('No command execution'),
      audit:event=>{if(failAudit&&event.action==='policy-execution-started')throw Error('audit failed');},transferRoot:root,uiHtml:'<html></html>',
      env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_TEST_SERVER_SECRET_REF:'secret://fixture/test-server',BRIDGE_COMMAND_AUTOMATION:String(automation),BRIDGE_TARGETS:JSON.stringify(entries),BRIDGE_DEFAULT_TARGET:'alpha'}});
    for (const e of entries) app.targets.select(e.id).transfers.download=async op=>{effects.push({target:e.id,...op});return {failed:false,texts:['server file ready']};};
    await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+app.adminHttp.address().port;
    const api=async(path,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer fixture-owner',Origin:'https://owner.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
    const set=async(downloads,sudo=false,target='alpha',changes={})=>{
      const current=(await api('/api/command-policy')).body,b=current.bindings.find(b=>b.targetId===target);
      const rule={targetId:target,targetRevision:b.targetRevision,profile:b.profile,commands:[],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{},automaticSudo:sudo,...changes,...(downloads===undefined?{}:{automaticDownloads:downloads})};
      const proposal={policy:{targets:[...current.targets.filter(r=>r.targetId!==target),rule]},expectedRevision:current.revision};
      const review=await api('/api/command-policy/review',proposal);assert.equal(review.status,200);
      assert.equal((await api('/api/command-policy',{...proposal,reviewToken:review.body.reviewToken,acknowledged:true})).status,200);return {review:review.body,rule,proposal};
    };
    const download=(elevate=false,target='alpha')=>app.targets.files.requestDownload({target,remotePath:'/tmp/fixture.txt',elevate});
    const finish=async job=>{await app.queue.wait(job.id);return app.queue.get(job.id);};
    await run({app,api,set,download,finish,effects,profiles});
  } finally {await app?.close();await rm(root,{recursive:true,force:true});}
}

test('downloads require explicit target opt-in and elevated downloads require both reviewed switches',async()=>fixture(async f=>{
  for(const flag of [undefined,false]){await f.set(flag,true);const job=f.download();assert.equal(job.state,'pending');assert.throws(()=>f.app.targets.select('alpha').queue.start(job.id,true));f.app.queue.deny(job.id);}
  const {review}=await f.set(true);assert.equal(review.feedback[0].level,'high_risk');assert.match(review.feedback[0].warning,/파일 자동다운로드/);
  const ready=await f.finish(f.download());assert.equal(ready.state,'completed');assert.equal(ready.approvalMode,'automatic');assert.equal(ready.decision.reasonCode,'download_policy');
  for(const job of [f.download(true),f.download(false,'beta')]){assert.equal(job.state,'pending');f.app.queue.deny(job.id);}
  await f.set(false,true);const onlySudo=f.download(true);assert.equal(onlySudo.state,'pending');f.app.queue.deny(onlySudo.id);
  await f.set(true,true);const elevated=await f.finish(f.download(true));assert.equal(elevated.approvalMode,'automatic');assert.equal(f.effects.length,2);
  assert.throws(()=>f.app.targets.select('alpha').queue.startDownload(elevated.id),/pending/);
  await f.set(false);const revoked=f.download();assert.equal(revoked.state,'pending');f.app.queue.deny(revoked.id);assert.equal(f.effects.length,2);
}));

test('download flag validation and exact feedback confirmation prevent unreviewed authority',async()=>fixture(async f=>{
  const {rule}=await f.set(false);for(const automaticDownloads of ['true',1,null,{}])assert.throws(()=>validateCommandPolicy({targets:[{...rule,automaticDownloads}]}));
  const current=(await f.api('/api/command-policy')).body,proposal={policy:{targets:current.targets},expectedRevision:current.revision};
  const review=(await f.api('/api/command-policy/review',proposal)).body;
  proposal.policy.targets[0].automaticDownloads=true;
  assert.equal((await f.api('/api/command-policy',{...proposal,reviewToken:review.reviewToken,acknowledged:true})).status,409);
  const job=f.download();assert.equal(job.state,'pending');f.app.queue.deny(job.id);assert.equal(f.effects.length,0);
}));

test('busy, stale target and audit failure cannot trigger or later retry an automatic download',async()=>{
  await fixture(async f=>{
    await f.set(true);let release;const gate=new Promise(r=>release=r),runtime=f.app.targets.select('alpha'),execute=runtime.transfers.download;
    runtime.transfers.download=async op=>{await gate;return execute(op);};
    const first=f.download(),second=f.download();assert.equal(second.state,'pending');release();await f.finish(first);assert.equal(f.app.queue.get(second.id).state,'pending');f.app.queue.deny(second.id);
    f.profiles.get('alpha-read').host='changed.test';const stale=f.download();assert.equal(stale.state,'pending');f.app.queue.deny(stale.id);assert.equal(f.effects.length,1);
  });
  await fixture(async f=>{await f.set(true);const job=f.download();assert.equal(job.state,'pending');assert.equal(job.approvalMode,undefined);assert.equal(f.effects.length,0);f.app.queue.deny(job.id);},{failAudit:true});
});

test('global automation OFF still permits owner-approved downloads, never policy execution',async()=>fixture(async f=>{
  const job=f.download();assert.equal(job.state,'pending');assert.equal(f.effects.length,0);await f.app.queue.approve(job.id);assert.equal(f.effects.length,1);assert.equal(f.app.queue.get(job.id).approvalMode,'owner');
},{automation:false}));

test('settings is a safe HTML entry while observation data remains owner authenticated and target bound',async()=>fixture(async f=>{
  const origin='http://127.0.0.1:'+f.app.adminHttp.address().port;
  const page=await fetch(origin+'/settings');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/^text\/html/);
  const history=await fetch(origin+'/history');assert.equal(history.status,200);assert.match(history.headers.get('content-type'),/^text\/html/);assert.match(await history.text(),/history-panel/);
  const html=await page.text();assert.match(html,/data-page-link/);assert.doesNotMatch(html,/fixture-owner|fixture-mcp/);
  assert.equal((await fetch(origin+'/api/automation-metrics')).status,401);
  const metrics=await f.api('/api/automation-metrics?target=alpha');assert.equal(metrics.status,200);assert.equal(metrics.body.available,true);assert.equal(metrics.body.total,0);
  assert.equal((await f.api('/api/automation-metrics?target=missing')).status,409);
}));


test('test server bypass covers elevated downloads without other flags and never leaks across targets',async()=>fixture(async f=>{
 await f.set(false,false,'alpha',{testServer:true});
 const done=await f.finish(f.download(true));assert.equal(done.state,'completed');assert.equal(done.decision.reasonCode,'test_server_bypass');
 const other=f.download(true,'beta');assert.equal(other.state,'pending');f.app.queue.deny(other.id);
 await f.set(false,false,'alpha',{testServer:false});const revoked=f.download(true);assert.equal(revoked.state,'pending');f.app.queue.deny(revoked.id);
 assert.equal(f.effects.length,1);
}));


test('test server download slot rejection is terminal rather than owner pending',async()=>fixture(async f=>{
 await f.set(false,false,'alpha',{testServer:true});const q=f.app.targets.select('alpha').queue,busy=q.externalBusy;q.externalBusy=()=>true;
 const job=f.download(true);assert.equal(job.state,'failed');assert.equal(job.decision.dispatchFailure,'not_dispatched');assert.equal(job.decision.dispatchFailureReason,'busy');assert.equal(job.decision.dispatchFailureStage,'busy_check');assert.equal(job.decision.dispatchFailureReason,'busy');assert.equal(job.decision.dispatchFailureStage,'busy_check');
 q.externalBusy=busy;assert.throws(()=>q.start(job.id),/not pending/);assert.equal(f.effects.length,0);
}));
