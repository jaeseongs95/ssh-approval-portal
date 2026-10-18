import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../app.mjs';
import { createEnvironmentEditor } from '../src/adapters/config/environment-editor.mjs';

const revision = 'a'.repeat(64), origin = 'https://admin.example.test';
const env = { BRIDGE_MCP_TOKEN:'synthetic-mcp', BRIDGE_ADMIN_TOKEN:'synthetic-admin', BRIDGE_UI_TICKET_KEY:'b'.repeat(64), BRIDGE_ADMIN_ORIGIN:origin };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('ENV HTTP authorization, Origin, types/limits, maintenance, audit and restart acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'env-http-')); const calls = [], audits = [];
  let failAudit = false;
  const app = await createApplication({ env, transferRoot:root, uiHtml:'',
    registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'synthetic',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},
    classify:()=>({class:'privileged'}), executeCommand:async()=>({texts:[]}), audit:event=>{ if(failAudit) throw Error('do-not-disclose-synthetic-secret'); audits.push(event); },
    environmentTransport:async request=>{ calls.push(request); return request.action==='restart' ? {accepted:true,restart:{id:'c'.repeat(32),state:'scheduled'}} : {available:true,revision,fields:[{key:'JEV_API_KEY',type:'secret',configured:true}],readOnlyKeys:['BRIDGE_ADMIN_TOKEN'],restart:{state:'idle'}}; },
  });
  try {
    await listen(app.adminHttp); const url=`http://127.0.0.1:${app.adminHttp.address().port}/api/environment`;
    const owner={Authorization:'Bearer synthetic-admin',Origin:origin,'Content-Type':'application/json'};
    const body={expectedRevision:revision,changes:{JEV_API_KEY:'synthetic-new-key'},acknowledged:true};
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{headers:{Authorization:'Bearer synthetic-mcp'}})).status,401);
    const get=await fetch(url,{headers:owner}); assert.equal(get.status,200); assert.equal(get.headers.get('cache-control'),'no-store');
    assert.ok(!(await get.text()).includes('synthetic-admin'));
    const post=(path='',headers=owner,data=body)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(data)});
    assert.equal((await post('',{...owner,Origin:'https://evil.test'})).status,403);
    assert.equal((await post('',{Authorization:owner.Authorization,'Content-Type':'application/json'})).status,403);
    assert.equal((await post('',{...owner,'Content-Type':'text/plain'})).status,415);
    assert.equal((await post('',owner,{...body,unexpected:'x'})).status,409);
    assert.equal((await post('',owner,{...body,acknowledged:false})).status,409);
    assert.equal((await post('',owner,{...body,changes:{JEV_API_KEY:'x'.repeat(33000)}})).status,413);
    const pending=app.queue.submit('synthetic-command');
    assert.equal((await post()).status,409); app.queue.deny(pending.id);
    assert.equal(calls.filter(c=>c.action==='save').length,0);
    assert.equal((await post()).status,200);
    assert.equal(calls.filter(c=>c.action==='save').length,1);
    assert.equal(app.queue.maintenance,false);
    assert.ok(!JSON.stringify(audits).includes('synthetic-new-key'));
    failAudit=true; const failed=await post(); assert.equal(failed.status,409); assert.ok(!(await failed.text()).includes('do-not-disclose-synthetic-secret'));
    failAudit=false;
    assert.equal((await post('/restart',owner,{expectedRevision:revision,acknowledged:true})).status,200);
    assert.equal(app.queue.maintenance,true);
    assert.equal((await post('/restart',owner,{expectedRevision:revision,acknowledged:true})).status,409);
    assert.equal(calls.filter(c=>c.action==='restart').length,1);
  } finally { await app.close(); await rm(root,{recursive:true}); }
});

test('ENV broker errors do not expose diagnostics, concurrent calls excluded, failed writes release maintenance', async () => {
  const events=[],state={busy:false,pending:0,maintenance:false}; let release, count=0;
  const lifecycle={snapshot:()=>state,reserve:()=>{state.maintenance=true;},release:()=>{state.maintenance=false;}};
  const service=createEnvironmentEditor({lifecycle,audit:e=>events.push(e),transport:async()=>{count++; await new Promise(resolve=>release=resolve); return {error:'conflict'};}});
  const first=service.mutate('save',{expectedRevision:revision,changes:{JEV_API_KEY:'synthetic'},acknowledged:true});
  await assert.rejects(service.mutate('save',{expectedRevision:revision,acknowledged:true}),/진행 중/);
  release(); await assert.rejects(first,/변경됐습니다/); assert.equal(state.maintenance,false); assert.equal(count,1);
  const unavailable=createEnvironmentEditor({lifecycle,audit:()=>{},transport:async()=>{throw Error('synthetic-server-secret');}});
  assert.equal((await unavailable.get()).available,false);
});
