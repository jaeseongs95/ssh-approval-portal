import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {createAgentCliState} from '../src/adapters/storage/agent-cli-state.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createOperationStore} from '../src/adapters/storage/operation-store.mjs';
import {capturePreservationSnapshot, comparePreservationSnapshots, baselinePreservationAccepted} from '../src/adapters/storage/preservation-verification.mjs';

test('real journals compare old rows and payload after restart, allowing expiry and new requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'preservation-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  let clock = 1000;
  const options = {now: () => clock, ttl: 100};
  let commandState = createCommandState(root), cliState = createAgentCliState(root), outputs = new CommandOutputs(root, options), operationStore = createOperationStore(root);
  const id = 'a'.repeat(48), cliId = 'b'.repeat(48);
  const job = {id, kind:'command', state:'completed', operation:{kind:'command', command:'true'}};
  const cliJob = {id:cliId, kind:'command', state:'completed', operation:{agentCliContract:'agent-cli-install-v1'}};
  commandState.insert(job, 'request-test-key', 'c'.repeat(64));
  cliState.insert(cliJob, 'agent-cli:request-key-000001', 'd'.repeat(64));
  const ref = outputs.finish(outputs.reserve({executionId:id}), {failed:false, texts:['private output']}).output;
  const capture = () => capturePreservationSnapshot({commandState, cliState, outputs, operationStore, now:clock});
  const before = capture();
  commandState.close(); cliState.close(); outputs.close(); operationStore.close();
  commandState = createCommandState(root); cliState = createAgentCliState(root); outputs = new CommandOutputs(root, options); operationStore = createOperationStore(root);
  let after = capture();
  assert.deepEqual(comparePreservationSnapshots(before, after), {status:'PASS', commandRequestsChecked:1, cliRequestsChecked:1, outputsChecked:1, outputPayloadsVerified:1, outputsUnavailable:0, expiredOutputsRemoved:0,
    comparisonContract:'baseline-preservation-v1', baselinePreserved:true, outputsAdded:0,
    baselineScope:'legacy-and-canonical', canonicalCoverage:'verified', canonicalOperationsChecked:0, canonicalOperationsAdded:0, canonicalEventsChecked:0, canonicalEventsAdded:0, canonicalLegacyBudgetChecked:0, canonicalLegacyBudgetAdded:0});
  assert.ok(!JSON.stringify(comparePreservationSnapshots(before, after)).includes('private output'));
  commandState.insert({...job,id:'e'.repeat(48)}, 'new-request-key', 'f'.repeat(64));
  after = capture(); assert.equal(comparePreservationSnapshots(before, after).status, 'PASS');
  commandState.save({...job, state:'failed'});
  assert.throws(() => comparePreservationSnapshots(before, capture()), /request changed/);
  commandState.save(job);
  cliState.save({...cliJob, state:'failed'});
  assert.throws(() => comparePreservationSnapshots(before, capture()), /request changed/);
  cliState.save(cliJob);
  const invalid = structuredClone(after); delete invalid.command.requests[id];
  assert.throws(() => comparePreservationSnapshots(before, invalid), /request changed/);
  const missing = structuredClone(after); delete missing.output.rows[ref.id];
  assert.throws(() => comparePreservationSnapshots(before, missing), /Unexpired output/);
  const payload = join(outputs.root, ref.id + '.out');
  const bytes = readFileSync(payload); bytes[0] ^= 1; writeFileSync(payload, bytes);
  assert.throws(() => comparePreservationSnapshots(before, capture()), /output changed/i);
  clock = 1101; outputs.reap(); after = capture();
  assert.equal(comparePreservationSnapshots(before, after).expiredOutputsRemoved, 1);
  assert.equal(comparePreservationSnapshots(before, after).status, 'PARTIAL');
  const pending = outputs.reserve({executionId:id});
  assert.throws(() => capture(), /Pending or invalid output/);
  outputs.abandon(pending);
  const unavailable = capture();
  const partial = comparePreservationSnapshots(unavailable, capture());
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.outputsUnavailable, 1);
  commandState.close(); cliState.close(); outputs.close(); operationStore.close();
});

test('baseline preservation distinguishes unchanged unavailable bodies from expiry, additions and actual loss', () => {
  const digest = 'a'.repeat(64), ready = '1'.repeat(48), unavailable = '2'.repeat(48);
  const before = {version:1, observedAt:1000, command:{schema:digest, policy:digest, requests:{[ready]:digest}}, cli:null,
    output:{schema:digest, rows:{[ready]:{row:digest, payload:digest, expiresAt:1100}, [unavailable]:{row:digest, payload:null, expiresAt:1100}}}};
  const result = comparePreservationSnapshots(before, structuredClone(before));
  assert.equal(result.baselineScope, 'legacy-only'); assert.equal(result.canonicalCoverage, 'not-in-baseline');
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.outputsUnavailable, 1);
  assert.equal(result.baselinePreserved, true); assert.equal(baselinePreservationAccepted(result), true);
  for (const change of [
    after => { after.output.rows[ready].payload = null; },
    after => { after.output.rows[ready].payload = 'b'.repeat(64); },
    after => { after.output.rows[unavailable].row = 'b'.repeat(64); },
    after => { after.output.rows[unavailable].payload = digest; },
    after => { delete after.output.rows[ready]; },
    after => { after.output.schema = 'b'.repeat(64); },
    after => { after.command.policy = 'b'.repeat(64); },
    after => { after.command.schema = 'b'.repeat(64); },
    after => { delete after.command.requests[ready]; },
  ]) {
    const after = structuredClone(before); change(after);
    assert.throws(() => comparePreservationSnapshots(before, after));
  }
  const expired = structuredClone(before); expired.observedAt = 1200; delete expired.output.rows[ready];
  const partial = comparePreservationSnapshots(before, expired);
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.expiredOutputsRemoved, 1);
  assert.equal(partial.baselinePreserved, false); assert.equal(baselinePreservationAccepted(partial), false);
  const added = structuredClone(before); added.output.rows['3'.repeat(48)] = {row:digest, payload:digest, expiresAt:1100};
  const unknown = comparePreservationSnapshots(before, added);
  assert.equal(unknown.status, 'PARTIAL'); assert.equal(unknown.outputsAdded, 1);
  assert.equal(unknown.baselinePreserved, false); assert.equal(baselinePreservationAccepted(unknown), false);
  for (const malformed of [{baselinePreserved:'true'}, {comparisonContract:'other'}, {outputsChecked:3}, {status:'PASS'}, {outputsAdded:1}, {expiredOutputsRemoved:1}])
    assert.equal(baselinePreservationAccepted({...result, ...malformed}), false);
});

test('capture rejects in-flight state; policy or journal deletion cannot pass comparison', () => {
  const hash = 'a'.repeat(64), now = 1000;
  const commandState = {preservationRows: () => ({schema:[], policy:[], requests:[{id:'1'.repeat(48), body:JSON.stringify({id:'1'.repeat(48),state:'running'})}]})};
  const outputs = {preservationRows: () => ({schema:[], outputs:[]})};
  const operationStore = {preservationRows: () => ({schema:[], operations:[], events:[], legacyBudget:[]})};
  assert.throws(() => capturePreservationSnapshot({commandState, outputs, operationStore, now}), /Nonterminal/);
  const before = {version:1, observedAt:now, command:{schema:hash,policy:hash,requests:{}},cli:null,output:{schema:hash,rows:{}}};
  const changed = structuredClone(before); changed.command.policy = 'b'.repeat(64);
  assert.throws(() => comparePreservationSnapshots(before, changed), /policy/);
  changed.command = null; assert.throws(() => comparePreservationSnapshots(before, changed), /presence/);
  changed.command = before.command; changed.observedAt = now - 1;
  assert.throws(() => comparePreservationSnapshots(before, changed), /snapshots/);
});

test('canonical capture requires its existing connection and performs SELECT only without exposing private bodies', t => {
  const root = mkdtempSync(join(tmpdir(), 'preservation-canonical-'));
  const store = createOperationStore(root), outputs = {preservationRows: () => ({schema:[], outputs:[]})};
  t.after(() => {store.close(); rmSync(root, {recursive:true, force:true});});
  const job = store.accept({requestKey:'PRIVATE_KEY_SENTINEL', owner:'PRIVATE_OWNER_SENTINEL', targetId:'private-target', targetRevision:'rev1', kind:'source', input:{source:'PRIVATE_SOURCE_SENTINEL'}});
  store.update(job.id, {state:'cancelled'});
  const before = readFileSync(store.filePath), prepare = DatabaseSync.prototype.prepare, sql = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (statement) {sql.push(statement); return prepare.call(this, statement);});
  const snapshot = capturePreservationSnapshot({outputs, operationStore:store, now:1000});
  assert.equal(snapshot.version, 2); assert.equal(snapshot.canonical.operations.length, 1); assert.equal(snapshot.canonical.events.count, 2);
  assert.ok(sql.length > 0 && sql.every(statement => /^SELECT\b/.test(statement)), JSON.stringify(sql));
  assert.deepEqual(readFileSync(store.filePath), before);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|private-target|operations.sqlite/);
  assert.throws(() => capturePreservationSnapshot({outputs, now:1000}), /Canonical/);
});

test('canonical comparator detects budget loss and event-prefix tampering, while keeping old baseline coverage explicit', () => {
  const outputs={preservationRows:()=>({schema:[], outputs:[]})};
  const operationStore={preservationRows:()=>({schema:[],operations:[],events:[],legacyBudget:[]})};
  const before=capturePreservationSnapshot({outputs,operationStore,now:1000});
  before.canonical.legacyBudget=['a'.repeat(64)];
  const after=structuredClone(before); after.canonical.legacyBudget=[];
  assert.throws(()=>comparePreservationSnapshots(before,after),/canonical record/);
  after.canonical.legacyBudget=[...before.canonical.legacyBudget];
  after.canonical.events.count=1; after.canonical.events.prefixCount=0; after.canonical.events.prefixDigest='b'.repeat(64);
  assert.throws(()=>comparePreservationSnapshots(before,after),/event prefix/);
  const legacy=structuredClone(before); legacy.version=1; delete legacy.canonical;
  const migrated=comparePreservationSnapshots(legacy,before);
  assert.equal(migrated.status,'PASS'); assert.equal(migrated.baselineScope,'legacy-only'); assert.equal(migrated.canonicalCoverage,'not-in-baseline');
  assert.equal(migrated.canonicalOperationsChecked,0); assert.equal(baselinePreservationAccepted(migrated),true);
  const incomplete=structuredClone(before); delete incomplete.canonical;
  assert.throws(()=>comparePreservationSnapshots(incomplete,before),/snapshots/);
  assert.throws(()=>comparePreservationSnapshots(before,legacy),/presence/);
});

for (const state of ['accepted','queued','starting','running','terminating']) test(`canonical ${state} cannot cross an idle preservation boundary`, t => {
  const root = mkdtempSync(join(tmpdir(), 'preservation-canonical-busy-')), store = createOperationStore(root);
  t.after(() => {store.close(); rmSync(root, {recursive:true, force:true});});
  const job = store.accept({requestKey:state, owner:'fixture', targetId:'alpha', targetRevision:'r1', kind:'command', input:{command:'true'}});
  if (state !== 'accepted') store.update(job.id, {state:'queued'});
  if (['starting','running','terminating'].includes(state)) store.claim(job.id);
  if (['running','terminating'].includes(state)) store.update(job.id, {state:'running'});
  if (state === 'terminating') store.update(job.id, {state:'terminating'});
  assert.throws(() => capturePreservationSnapshot({operationStore:store, outputs:{preservationRows:()=>({schema:[],outputs:[]})}, now:1000}), /PRESERVATION_NOT_IDLE/);
});
