import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApplication} from '../app.mjs';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {createOperationStore} from '../src/adapters/storage/operation-store.mjs';

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

test('reserved startup defers legacy output conversion and preserves strict baseline rows and payload', async () => {
  const root=await mkdtemp(join(tmpdir(),'ssh-preservation-legacy-')); let app;
  const id='d'.repeat(48), storedId='e'.repeat(48), now=Date.now();
  const original={failed:false,texts:['LEGACY_PRIVATE_SENTINEL'],data:{raw:'LEGACY_PRIVATE_SENTINEL'}};
  const legacy={id,kind:'command',operation:{kind:'command',command:'sudo id'},command:'sudo id',profile:'aws-local',commandClass:'privileged',target:'fixture@127.0.0.1:22',state:'completed',createdAt:now,finishedAt:now,expiresAt:now+3600000,result:original};
  const rows=()=>{const db=new DatabaseSync(join(root,'command-automation.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM requests ORDER BY id').all();}finally{db.close();}};
  try {
    const outputs=new CommandOutputs(root);
    const existing=outputs.finish(outputs.reserve({executionId:storedId}),{failed:false,texts:['EXISTING_PRIVATE_PAYLOAD']});
    const payload=join(outputs.root,existing.output.id+'.out');outputs.close();
    const state=createCommandState(root);state.insert(legacy,'legacy-request-key','f'.repeat(64));state.insert({...legacy,id:storedId,result:existing},'stored-request-key','a'.repeat(64));state.close();
    // A prior service without automation can reserve and capture the existing legacy journal.
    app=await open(root,'false');await listen(app);
    assert.equal((await post(app,'reserve')).status,200);assert.equal((await post(app,'preservation/capture')).status,200);
    await app.close();app=undefined;
    const before=rows(),payloadBefore=await readFile(payload);
    app=await open(root);await listen(app);
    assert.equal(app.queue.maintenance,true);
    const comparison=await post(app,'preservation/compare');assert.equal(comparison.status,200,'legacy conversion must not change a reserved baseline');
    const report=await comparison.json();assert.equal(report.status,'PASS');assert.equal(report.commandRequestsChecked,2);assert.equal(report.outputPayloadsVerified,1);
    const restored=app.queue.get(id);assert.equal(restored.state,'completed');assert.deepEqual(restored.operation,legacy.operation);assert.equal(restored.expiresAt,legacy.expiresAt);
    assert.equal(restored.result.output.state,'unavailable');assert.deepEqual(restored.result.texts,[]);assert.ok(!JSON.stringify(restored).includes('LEGACY_PRIVATE_SENTINEL'));
    const history=await fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/requests`,{headers:{Authorization:'Bearer test-admin'}});
    assert.equal(history.status,200);assert.ok(!(await history.text()).includes('LEGACY_PRIVATE_SENTINEL'));
    assert.equal((await post(app,'release')).status,200);
    await app.close();app=undefined;
    assert.deepEqual(rows(),before,'reserved startup must retain every original row byte');assert.deepEqual(await readFile(payload),payloadBefore);
    // Conversion is deferred until an ordinary startup, rather than discarded or performed on release.
    app=await open(root);assert.equal(app.queue.get(id).result.output.state,'ready');await app.close();app=undefined;
    const after=rows();assert.deepEqual(after.map(({id,request_key,digest})=>({id,request_key,digest})),before.map(({id,request_key,digest})=>({id,request_key,digest})));
    assert.deepEqual(JSON.parse(after.find(row=>row.id===id).body).operation,legacy.operation);
    assert.deepEqual(await readFile(payload),payloadBefore);
  } finally {await app?.close();await rm(root,{recursive:true,force:true});}
});

const canonicalId = 'c'.repeat(48), legacyId = 'd'.repeat(48);
function seedCanonical(root, id = canonicalId) {
  const store = createOperationStore(root);
  try {
    store.accept({id, requestKey:'fixture-key-'+id, owner:'fixture-owner', targetId:'fixture-only-target', targetRevision:'fixture-revision', kind:'source', input:{source:'CANONICAL_PRIVATE_SENTINEL'}});
    store.update(id, {state:'cancelled'});
    if (id === canonicalId) store.importLegacy({id:legacyId, state:'completed', createdAt:1000, finishedAt:1100, operation:{kind:'command',command:'LEGACY_PRIVATE_SENTINEL'}}, {source:'fixture-history'});
  } finally {store.close();}
}

for (const [name, sql] of [
  ['missing operation', 'DELETE FROM operations WHERE id=?'],
  ['body', "UPDATE operations SET body=json_set(body,'$.input.source','CHANGED_PRIVATE_SENTINEL') WHERE id=?"],
  ['request key', "UPDATE operations SET request_key='changed-key' WHERE id=?"],
  ['contract', "UPDATE operations SET contract=contract||' ' WHERE id=?"],
  ['digest', "UPDATE operations SET digest='changed-digest' WHERE id=?"],
  ['target', "UPDATE operations SET target_id='changed-target' WHERE id=?"],
  ['target revision', "UPDATE operations SET target_revision='changed-revision' WHERE id=?"],
  ['state', "UPDATE operations SET state='failed',body=json_set(body,'$.state','failed') WHERE id=?"],
  ['missing event', 'DELETE FROM operation_events WHERE operation_id=? AND version=1'],
  ['changed event', 'UPDATE operation_events SET at=at+1 WHERE operation_id=? AND version=1'],
  ['legacy budget', 'UPDATE operation_legacy_budget SET reserved_bytes=reserved_bytes+1 WHERE operation_id=?'],
  ['schema', 'CREATE INDEX fixture_changed_schema ON operations(digest)'],
]) test(`canonical preservation rejects ${name} across real service replacement`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-preservation-canonical-change-')); let app;
  try {
    seedCanonical(root); app=await open(root); await listen(app);
    assert.equal((await post(app,'reserve')).status,200);
    assert.equal((await post(app,'preservation/capture')).status,200);
    await app.close(); app=undefined;
    const db=new DatabaseSync(join(root,'operations.sqlite'));
    try {const statement=db.prepare(sql); name === 'schema' ? statement.run() : statement.run(name === 'legacy budget' ? legacyId : canonicalId);} finally {db.close();}
    app=await open(root); await listen(app);
    const response=await post(app,'preservation/compare'), body=await response.text();
    assert.equal(response.status,409,`${name} must not receive a preservation PASS`);
    assert.doesNotMatch(body, /PRIVATE_SENTINEL|changed-key|changed-target|operations.sqlite|fixture-owner/);
    assert.equal(app.queue.maintenance,true);
    const release=await fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/release`, {method:'POST',headers:{Authorization:'Bearer test-admin',Origin:origin,'X-Maintenance-Owner':owner,'X-Maintenance-Compare-Required':'1'}});
    assert.equal(release.status,409);
  } finally {await app?.close(); await rm(root,{recursive:true,force:true});}
});

test('canonical preservation counts retained rows and event prefix separately from legitimate new history', async () => {
  const root=await mkdtemp(join(tmpdir(),'ssh-preservation-canonical-add-')); let app;
  try {
    seedCanonical(root); app=await open(root); await listen(app);
    assert.equal((await post(app,'reserve')).status,200);
    assert.equal((await post(app,'preservation/capture')).status,200);
    // Baseline is private, durable, and contains hashes rather than source/key/owner bodies.
    await app.close(); app=undefined;
    const db=new DatabaseSync(join(root,'maintenance.sqlite'), {readOnly:true});
    try {assert.doesNotMatch(db.prepare('SELECT baseline FROM reservation').get().baseline, /PRIVATE_SENTINEL|fixture-key|fixture-owner|fixture-only-target/);} finally {db.close();}
    seedCanonical(root,'e'.repeat(48));
    app=await open(root); await listen(app);
    const response=await post(app,'preservation/compare'), report=await response.json();
    assert.equal(response.status,200); assert.equal(report.status,'PASS');
    assert.equal(report.baselineScope,'legacy-and-canonical'); assert.equal(report.canonicalCoverage,'verified');
    assert.equal(report.canonicalOperationsChecked,2); assert.equal(report.canonicalOperationsAdded,1);
    assert.equal(report.canonicalEventsChecked,4); assert.equal(report.canonicalEventsAdded,2);
    assert.equal(report.canonicalLegacyBudgetChecked,1); assert.equal(report.canonicalLegacyBudgetAdded,0);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_SENTINEL|fixture-key|fixture-owner|operations.sqlite/);
  } finally {await app?.close(); await rm(root,{recursive:true,force:true});}
});
