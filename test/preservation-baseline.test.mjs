import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../app.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';

const owner = 'a'.repeat(64), other = 'b'.repeat(64), contract = 'baseline-preservation-v1';
const baseline = {'X-Maintenance-Preservation-Contract':contract};
const verified = {'X-Maintenance-Compare-Required':'1'};
const env = {BRIDGE_MCP_TOKEN:'test-mcp', BRIDGE_ADMIN_TOKEN:'test-admin', BRIDGE_ADMIN_ORIGIN:'https://example.test', BRIDGE_UI_TICKET_KEY:'b'.repeat(64), BRIDGE_UI_ENABLED:'true'};
async function fixture({unavailable = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'preservation-baseline-'));
  const outputs = new CommandOutputs(root);
  const ready = outputs.finish(outputs.reserve({executionId:'1'.repeat(48)}), {failed:false, texts:['PRIVATE_PAYLOAD_SENTINEL']}).output;
  if (unavailable) outputs.abandon(outputs.reserve({executionId:'2'.repeat(48)}));
  outputs.close();
  let app;
  const open = async () => {
    app = await createApplication({transferRoot:root, env, uiHtml:'', registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}}, classify:()=>({class:'privileged'}), executeCommand:async()=>({texts:[]}), audit:()=>{}});
    await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  };
  const post = (action, headers = {}, token = owner) => fetch(`http://127.0.0.1:${app.adminHttp.address().port}/api/maintenance/${action}`, {
    method:'POST', headers:{Authorization:'Bearer test-admin', Origin:env.BRIDGE_ADMIN_ORIGIN, 'X-Maintenance-Owner':token, ...headers}});
  const restart = async (afterStop = async () => {}) => { await app.close(); app = undefined; await afterStop(); await open(); };
  await open();
  assert.equal((await post('reserve')).status, 200);
  assert.equal((await post('preservation/capture')).status, 200);
  await restart();
  return {post, restart, root, ready, maintenance:()=>app.queue.maintenance,
    corrupt:async()=>{const file=join(root,'command-outputs',ready.id+'.out'), bytes=await readFile(file);bytes[0]^=1;await writeFile(file,bytes);},
    close:async()=>{await app?.close();await rm(root,{recursive:true,force:true});}};
}

test('baseline mode preserves unavailable rows without promoting partial evidence to strict release', async () => {
  const f = await fixture();
  try {
    const capabilities = await (await f.post('capabilities')).json();
    assert.equal(capabilities.baselineComparison, contract);
    assert.equal((await f.post('release', {...baseline,...verified})).status, 409);
    const strict = await (await f.post('preservation/compare')).json();
    assert.equal(strict.status, 'PARTIAL'); assert.equal(strict.outputsUnavailable, 1); assert.equal(strict.baselinePreserved, true);
    assert.equal((await f.post('release', verified)).status, 409);
    assert.equal((await f.post('release', {...baseline,...verified})).status, 409, 'strict comparison cannot grant baseline authorization');
    const response = await f.post('preservation/compare', baseline), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.comparisonContract, contract);
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.baselinePreserved, true);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PAYLOAD_SENTINEL'));
    assert.equal((await f.post('release', verified)).status, 409);
    assert.equal((await f.post('release', {...baseline,...verified}, other)).status, 409);
    assert.equal((await f.post('release', baseline)).status, 409, 'contract header cannot turn normal release into verified release');
    const release = await f.post('release', {...baseline,...verified});
    assert.equal(release.status, 200); assert.equal((await release.json()).comparisonContract, contract);
    assert.equal(f.maintenance(), false);
    assert.equal((await f.post('release', {...baseline,...verified})).status, 200, 'lost reply is reconcilable in the same mode and instance');
    assert.equal((await f.post('release', verified)).status, 409);
  } finally { await f.close(); }
});

test('baseline PASS still cannot grant strict release, nor can strict PASS grant baseline release', async () => {
  const f = await fixture({unavailable:false});
  try {
    assert.equal((await (await f.post('preservation/compare', baseline)).json()).status, 'PASS');
    assert.equal((await f.post('release', verified)).status, 409);
    assert.equal((await (await f.post('preservation/compare')).json()).status, 'PASS');
    assert.equal((await f.post('release', {...baseline,...verified})).status, 409);
    assert.equal((await f.post('release', verified)).status, 200);
  } finally { await f.close(); }
});

test('failed or unknown-mode recompare revokes earlier same-instance verification', async () => {
  for (const mode of ['strict','baseline']) for (const failure of ['payload','contract']) {
    const f = await fixture({unavailable:mode === 'baseline'}), headers = mode === 'baseline' ? baseline : {};
    try {
      assert.equal((await f.post('preservation/compare', headers)).status, 200);
      if (failure === 'payload') await f.corrupt();
      const response = await f.post('preservation/compare', failure === 'payload' ? headers : {'X-Maintenance-Preservation-Contract':'unknown'});
      assert.equal(response.status, 409);
      assert.equal((await f.post('release', {...baseline,...verified})).status, 409);
      assert.equal((await f.post('release', verified)).status, 409); assert.equal(f.maintenance(), true);
    } finally { await f.close(); }
  }
});

test('a newly added ready or unavailable output is not evidence of unchanged baseline state', async () => {
  for (const ready of [true,false]) {
    const f = await fixture();
    try {
      await f.restart(async () => {
        const outputs = new CommandOutputs(f.root);
        try {
          const item = outputs.reserve({executionId:'3'.repeat(48)});
          if (ready) outputs.finish(item,{failed:false,texts:['NEW_PRIVATE_PAYLOAD']}); else outputs.abandon(item);
        } finally { outputs.close(); }
      });
      const response = await f.post('preservation/compare', baseline), report = await response.json();
      assert.equal(response.status,200); assert.equal(report.status,'PARTIAL');
      assert.equal(report.outputsAdded,1); assert.equal(report.baselinePreserved,false);
      assert.ok(!JSON.stringify(report).includes('NEW_PRIVATE_PAYLOAD'));
      assert.equal((await f.post('release',{...baseline,...verified})).status,409);
      assert.equal(f.maintenance(),true);
    } finally { await f.close(); }
  }
});

test('verified release rechecks payload after compare; a restart cannot reuse verification', async () => {
  for (const mode of ['strict','baseline']) {
    const f = await fixture({unavailable:mode === 'baseline'}), headers = mode === 'baseline' ? baseline : {};
    try {
      assert.equal((await f.post('preservation/compare', headers)).status, 200);
      await f.corrupt();
      assert.equal((await f.post('release', {...headers,...verified})).status, 409);
      assert.equal(f.maintenance(), true);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    assert.equal((await f.post('preservation/compare', baseline)).status, 200);
    await f.restart();
    assert.equal((await f.post('release', {...baseline,...verified})).status, 409);
    assert.equal(f.maintenance(), true);
  } finally { await f.close(); }
});

test('baseline client requires explicit server capability, exact contract and unambiguous evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-client-')), secret = join(root, 'env'); await writeFile(secret, '');
  const calls = [];
  let support = false, releaseContract = true;
  const valid = {status:'PARTIAL', commandRequestsChecked:0, cliRequestsChecked:0, outputsChecked:1, outputPayloadsVerified:0,
    outputsUnavailable:1, expiredOutputsRemoved:0, comparisonContract:contract, baselinePreserved:true, outputsAdded:0};
  let comparison = {...valid};
  const server = createServer((req,res) => {
    calls.push({path:req.url, contract:req.headers['x-maintenance-preservation-contract'], required:req.headers['x-maintenance-compare-required']});
    const result = req.url.endsWith('capabilities') ? (support ? {baselineComparison:contract} : {})
      : req.url.endsWith('compare') ? comparison : req.url.endsWith('status') ? {status:'reserved'}
      : req.url.endsWith('release') ? {released:true,...(releaseContract ? {comparisonContract:contract} : {})}
      : req.url.endsWith('reserve') ? {reserved:true} : {captured:true};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ownership:'durable-v1',...result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const run = action => new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[fileURLToPath(new URL('../scripts/maintenance.mjs',import.meta.url)),action], {windowsHide:true,
      env:{...process.env,BRIDGE_SECRET_ENV_FILE:secret,BRIDGE_ADMIN_PORT:String(server.address().port),BRIDGE_ADMIN_TOKEN:'test-admin',BRIDGE_MCP_TOKEN:'test-mcp',BRIDGE_ADMIN_ORIGIN:env.BRIDGE_ADMIN_ORIGIN}});
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    child.on('error',reject);child.on('close',code=>resolve({code,output}));child.stdin.end(owner);
  });
  try {
    for (const action of ['compare-baseline','release-baseline-verified']) {
      calls.length=0;assert.notEqual((await run(action)).code,0);
      assert.deepEqual(calls.map(x=>x.path),['/api/maintenance/capabilities']);
    }
    for (const action of ['reserve','capture','status']) assert.equal((await run(action)).code,0, 'legacy general mode stays compatible');
    comparison={status:'PASS',commandRequestsChecked:0,cliRequestsChecked:0,outputsChecked:0,outputPayloadsVerified:0,outputsUnavailable:0,expiredOutputsRemoved:0};
    assert.equal((await run('compare')).code,0, 'legacy strict PASS remains compatible');
    comparison={...valid};assert.notEqual((await run('compare')).code,0, 'strict compare never accepts baseline PARTIAL');
    support=true;
    const accepted=await run('compare-baseline');assert.equal(accepted.code,0);assert.match(accepted.output,/complete payload preservation was not verified/);assert.ok(!accepted.output.includes(owner));
    const summary=JSON.parse(accepted.output.split('\n').find(line=>line.startsWith('{')));
    assert.deepEqual(summary,valid);
    assert.equal(calls.at(-1).contract,contract);
    for (const override of [{comparisonContract:'other'},{baselinePreserved:undefined},{baselinePreserved:'true'},
      {expiredOutputsRemoved:1},{outputsAdded:1},{outputsChecked:2},{status:'unknown'},{outputPayloadsVerified:-1}]) {
      comparison={...valid,...override};const rejected=await run('compare-baseline');assert.notEqual(rejected.code,0);
      assert.doesNotMatch(rejected.output,/confirmed|\{"/);
    }
    comparison={...valid};releaseContract=false;
    assert.notEqual((await run('release-baseline-verified')).code,0);
    releaseContract=true;assert.equal((await run('release-baseline-verified')).code,0);
    assert.equal(calls.at(-1).required,'1');assert.equal(calls.at(-1).contract,contract);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
