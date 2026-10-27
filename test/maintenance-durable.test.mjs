import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createMaintenanceState } from '../src/adapters/storage/maintenance-state.mjs';
import { createApplication } from '../app.mjs';

const owner = 'a'.repeat(64), other = 'b'.repeat(64), origin = 'https://example.test';
const env = { BRIDGE_MCP_TOKEN:'test-mcp', BRIDGE_ADMIN_TOKEN:'test-admin', BRIDGE_ADMIN_ORIGIN:origin, BRIDGE_UI_TICKET_KEY:'b'.repeat(64), BRIDGE_UI_ENABLED:'true' };
const open = root => createApplication({ transferRoot:root, env, uiHtml:'',
  registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},
  classify:()=>({class:'privileged'}), executeCommand:async()=>({texts:[]}), audit:()=>{} });
const listen = app => new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
const post = (app, action, token=owner) => fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/${action}`, {
  method:'POST', headers:{Authorization:'Bearer test-admin', Origin:origin, 'X-Maintenance-Owner':token} });

test('reservation is owner-bound across replacement and preservation comparison requires a new instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-durable-maint-')); let first, second;
  try {
    first = await open(root); await listen(first);
    assert.equal((await post(first,'reserve','')).status,409);
    assert.equal((await post(first,'capabilities')).status,200);
    assert.deepEqual(await (await post(first,'reserve')).json(), {reserved:true,ownership:'durable-v1'});
    assert.equal((await post(first,'reserve')).status,200);
    assert.equal((await post(first,'reserve',other)).status,409);
    assert.equal((await post(first,'release',other)).status,409);
    assert.equal((await post(first,'preservation/capture',other)).status,409);
    assert.equal((await post(first,'preservation/capture')).status,200);
    assert.equal((await post(first,'preservation/capture')).status,200,'a lost reply can be reconciled without replacing the baseline');
    assert.equal((await post(first,'preservation/compare')).status,409);
    await first.close(); first = undefined;
    second = await open(root); await listen(second);
    assert.equal(second.queue.maintenance,true);
    assert.throws(()=>second.queue.submit('id'),/Maintenance/);
    assert.equal((await post(second,'release',other)).status,409);
    assert.equal((await post(second,'preservation/capture')).status,409,'a newer instance cannot replace the fixed baseline');
    const result=await post(second,'preservation/compare');
    assert.equal(result.status,200); const report=await result.json();
    assert.equal(report.status,'PASS');
    assert.ok(!JSON.stringify(report).includes(owner));
    assert.equal((await post(second,'status')).status,200);
    assert.equal((await (await post(second,'status')).json()).status,'reserved');
    assert.equal((await post(second,'release')).status,200);
    assert.equal(second.queue.maintenance,false);
    assert.equal((await (await post(second,'status')).json()).status,'released');
    assert.equal((await post(second,'release')).status,200,'lost release response can be retried');
    assert.equal((await post(second,'reserve')).status,409,'a released owner cannot be reused');
    await second.close(); second = await open(root); await listen(second);
    assert.equal((await (await post(second,'status')).json()).status,'released','receipt survives replacement');
    assert.equal((await post(second,'reserve',other)).status,200);
    assert.equal((await (await post(second,'status')).json()).status,'unknown','another reservation cannot be mistaken for recovery');
    assert.equal((await post(second,'release')).status,409,'old owner cannot release the new reservation');
    assert.equal(second.queue.maintenance,true);
    assert.equal((await post(second,'release',other)).status,200);
    assert.equal((await (await post(second,'status')).json()).status,'unknown','superseded receipt is conservative');
  } finally { await first?.close(); await second?.close(); await rm(root,{recursive:true,force:true}); }
});


test('a crashed owner survives process exit and a concurrent process cannot take the SQLite claim', async () => {
  const root=await mkdtemp(join(tmpdir(),'ssh-maint-crash-'));
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/adapters/storage/maintenance-state.mjs')).href;
  const script=`import {createMaintenanceState} from ${JSON.stringify(moduleUrl)}; const s=createMaintenanceState(process.argv[1]); s.reserve('a'.repeat(64)); process.exit(0);`;
  try {
    const held=createMaintenanceState(root);
    const blocked=spawnSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',timeout:5000});
    assert.notEqual(blocked.status,0,'another process cannot reserve or initialize during live ownership');
    held.close();
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',timeout:5000});
    assert.equal(crashed.status,0);
    const recovered=createMaintenanceState(root);
    try { assert.equal(recovered.occupied(),true); assert.equal(recovered.owns(owner),true); assert.throws(()=>recovered.release(other)); recovered.release(owner); }
    finally { recovered.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});
