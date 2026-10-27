import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {prepareOfflinePreservationBaseline} from '../src/adapters/storage/offline-preservation.mjs';
import {createApplication} from '../app.mjs';

const owner='a'.repeat(64), origin='https://example.test';
const env={BRIDGE_MCP_TOKEN:'test-mcp',BRIDGE_ADMIN_TOKEN:'test-admin',BRIDGE_ADMIN_ORIGIN:origin,BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_UI_ENABLED:'true',BRIDGE_COMMAND_AUTOMATION:'true'};
const open=root=>createApplication({transferRoot:root,env,uiHtml:'',registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>({texts:[]}),audit:()=>{}});
const post=(app,action)=>fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/${action}`,{method:'POST',headers:{Authorization:'Bearer test-admin',Origin:origin,'X-Maintenance-Owner':owner}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('offline baseline leaves old databases untouched and verifies first candidate startup', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ssh-offline-preservation-'));let app;
  try {
    const id='1'.repeat(48), commands=createCommandState(root);
    commands.insert({id,kind:'command',state:'completed',operation:{kind:'command',command:'true'}},'fixed-request','2'.repeat(64)); commands.close();
    const outputs=new CommandOutputs(root);outputs.finish(outputs.reserve({executionId:id}),{failed:false,texts:['private result']});outputs.close();
    const paths=[join(root,'command-automation.sqlite'),join(root,'command-outputs','manifest.sqlite')];
    const before=await Promise.all(paths.map(async path=>sha(await readFile(path))));
    assert.deepEqual(prepareOfflinePreservationBaseline({root,owner,commandEnabled:true,cliEnabled:false}),{status:'PREPARED',commandEnabled:true,cliEnabled:false});
    assert.deepEqual(await Promise.all(paths.map(async path=>sha(await readFile(path)))),before);
    app=await open(root);await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
    const result=await post(app,'preservation/compare');assert.equal(result.status,200);
    const report=await result.json();assert.equal(report.status,'PASS');assert.equal(report.commandRequestsChecked,1);assert.equal(report.outputPayloadsVerified,1);
    assert.ok(!JSON.stringify(report).includes('private result'));
    assert.equal((await post(app,'release')).status,200);
  } finally {await app?.close();await rm(root,{recursive:true,force:true});}
});

test('offline preparation refuses a live database owner and leaves no reservation file', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ssh-offline-busy-'));let commands,outputs;
  try {
    commands=createCommandState(root);outputs=new CommandOutputs(root);
    assert.throws(()=>prepareOfflinePreservationBaseline({root,owner,commandEnabled:true,cliEnabled:false}));
    await assert.rejects(()=>stat(join(root,'maintenance.sqlite')), {code:'ENOENT'});
  } finally {commands?.close();outputs?.close();await rm(root,{recursive:true,force:true});}
});

test('offline baseline refuses interrupted requests and first startup detects later data changes', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ssh-offline-change-'));let app;
  try {
    const id='3'.repeat(48), commands=createCommandState(root);
    const job={id,kind:'command',state:'pending',operation:{kind:'command',command:'true'}};
    commands.insert(job,'pending-request','4'.repeat(64));commands.close();
    const outputs=new CommandOutputs(root);outputs.close();
    assert.throws(()=>prepareOfflinePreservationBaseline({root,owner,commandEnabled:true,cliEnabled:false}),/Nonterminal/);
    await assert.rejects(()=>stat(join(root,'maintenance.sqlite')), {code:'ENOENT'});
    const db=new DatabaseSync(join(root,'command-automation.sqlite'));
    try {db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify({...job,state:'completed'}),id);} finally {db.close();}
    prepareOfflinePreservationBaseline({root,owner,commandEnabled:true,cliEnabled:false});
    const changed=new DatabaseSync(join(root,'command-automation.sqlite'));
    try {changed.prepare('UPDATE requests SET digest=? WHERE id=?').run('5'.repeat(64),id);} finally {changed.close();}
    app=await open(root);await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
    const result=await post(app,'preservation/compare');assert.notEqual(result.status,200);assert.ok(!(await result.text()).includes(id));
  } finally {await app?.close();await rm(root,{recursive:true,force:true});}
});
