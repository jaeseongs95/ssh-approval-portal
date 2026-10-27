import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../app.mjs';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';

const owner='a'.repeat(64), origin='https://example.test';
const env={BRIDGE_MCP_TOKEN:'test-mcp',BRIDGE_ADMIN_TOKEN:'test-admin',BRIDGE_ADMIN_ORIGIN:origin,BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_UI_ENABLED:'true',BRIDGE_COMMAND_AUTOMATION:'true'};
const open=(root,automation='true')=>createApplication({transferRoot:root,env:{...env,BRIDGE_COMMAND_AUTOMATION:automation},uiHtml:'',registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>({texts:[]}),audit:()=>{}});
const listen=app=>new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
const post=(app,action,token=owner)=>fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/${action}`,{method:'POST',headers:{Authorization:'Bearer test-admin',Origin:origin,'X-Maintenance-Owner':token}});

test('persisted baseline detects a real journal change during service replacement', async () => {
  const root=await mkdtemp(join(tmpdir(),'ssh-preservation-integration-')); let app;
  try {
    const state=createCommandState(root);
    const id='1'.repeat(48);
    state.insert({id,kind:'command',state:'completed',operation:{kind:'command',command:'true'}},'fixed-request','2'.repeat(64));
    state.close();
    app=await open(root); await listen(app);
    assert.equal((await post(app,'reserve')).status,200);
    assert.equal((await post(app,'preservation/capture')).status,200);
    assert.equal((await post(app,'release','b'.repeat(64))).status,409);
    await app.close(); app=undefined;
    const db=new DatabaseSync(join(root,'command-automation.sqlite'));
    try { db.prepare('UPDATE requests SET digest=? WHERE id=?').run('3'.repeat(64),id); }
    finally { db.close(); }
    app=await open(root); await listen(app);
    const result=await post(app,'preservation/compare');
    assert.notEqual(result.status,200);
    assert.ok(!(await result.text()).includes(id));
  } finally { await app?.close(); await rm(root,{recursive:true,force:true}); }
});

for (const [before, after] of [['true','false'], ['false','true']]) {
  test(`automation ${before} to ${after} preserves the existing journal across restart`, async () => {
    const root=await mkdtemp(join(tmpdir(),'ssh-preservation-toggle-')); let app;
    try {
      const state=createCommandState(root), id='a'.repeat(48);
      state.insert({id,kind:'command',state:'completed',operation:{kind:'command',command:'true'}},'fixed-request','c'.repeat(64));
      state.close();
      app=await open(root,before); await listen(app);
      assert.equal((await post(app,'reserve')).status,200);
      assert.equal((await post(app,'preservation/capture')).status,200);
      await app.close(); app=undefined;
      app=await open(root,after); await listen(app);
      const result=await post(app,'preservation/compare');
      assert.equal(result.status,200);
      assert.equal((await result.json()).commandRequestsChecked,1);
      assert.equal((await post(app,'release')).status,200);
    } finally { await app?.close(); await rm(root,{recursive:true,force:true}); }
  });
}

test('enabling automation for the first time allows its new journal', async () => {
  const root=await mkdtemp(join(tmpdir(),'ssh-preservation-first-toggle-')); let app;
  try {
    app=await open(root,'false'); await listen(app);
    assert.equal((await post(app,'reserve')).status,200);
    assert.equal((await post(app,'preservation/capture')).status,200);
    await app.close(); app=undefined;
    app=await open(root,'true'); await listen(app);
    const result=await post(app,'preservation/compare');
    assert.equal(result.status,200);
    assert.equal((await result.json()).status,'PASS');
    assert.equal((await post(app,'release')).status,200);
  } finally { await app?.close(); await rm(root,{recursive:true,force:true}); }
});
