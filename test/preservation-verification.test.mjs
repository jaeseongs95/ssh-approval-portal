import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandState} from '../src/adapters/storage/command-state.mjs';
import {createAgentCliState} from '../src/adapters/storage/agent-cli-state.mjs';
import {CommandOutputs} from '../src/adapters/storage/command-output.mjs';
import {capturePreservationSnapshot, comparePreservationSnapshots, baselinePreservationAccepted} from '../src/adapters/storage/preservation-verification.mjs';

test('real journals compare old rows and payload after restart, allowing expiry and new requests', t => {
  const root = mkdtempSync(join(tmpdir(), 'preservation-')); t.after(() => rmSync(root, {recursive: true, force: true}));
  let clock = 1000;
  const options = {now: () => clock, ttl: 100};
  let commandState = createCommandState(root), cliState = createAgentCliState(root), outputs = new CommandOutputs(root, options);
  const id = 'a'.repeat(48), cliId = 'b'.repeat(48);
  const job = {id, kind:'command', state:'completed', operation:{kind:'command', command:'true'}};
  const cliJob = {id:cliId, kind:'command', state:'completed', operation:{agentCliContract:'agent-cli-install-v1'}};
  commandState.insert(job, 'request-test-key', 'c'.repeat(64));
  cliState.insert(cliJob, 'agent-cli:request-key-000001', 'd'.repeat(64));
  const ref = outputs.finish(outputs.reserve({executionId:id}), {failed:false, texts:['private output']}).output;
  const capture = () => capturePreservationSnapshot({commandState, cliState, outputs, now:clock});
  const before = capture();
  commandState.close(); cliState.close(); outputs.close();
  commandState = createCommandState(root); cliState = createAgentCliState(root); outputs = new CommandOutputs(root, options);
  let after = capture();
  assert.deepEqual(comparePreservationSnapshots(before, after), {status:'PASS', commandRequestsChecked:1, cliRequestsChecked:1, outputsChecked:1, outputPayloadsVerified:1, outputsUnavailable:0, expiredOutputsRemoved:0,
    comparisonContract:'baseline-preservation-v1', baselinePreserved:true, outputsAdded:0});
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
  commandState.close(); cliState.close(); outputs.close();
});

test('baseline preservation distinguishes unchanged unavailable bodies from expiry, additions and actual loss', () => {
  const digest = 'a'.repeat(64), ready = '1'.repeat(48), unavailable = '2'.repeat(48);
  const before = {version:1, observedAt:1000, command:{schema:digest, policy:digest, requests:{[ready]:digest}}, cli:null,
    output:{schema:digest, rows:{[ready]:{row:digest, payload:digest, expiresAt:1100}, [unavailable]:{row:digest, payload:null, expiresAt:1100}}}};
  const result = comparePreservationSnapshots(before, structuredClone(before));
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
  assert.throws(() => capturePreservationSnapshot({commandState, outputs, now}), /Nonterminal/);
  const before = {version:1, observedAt:now, command:{schema:hash,policy:hash,requests:{}},cli:null,output:{schema:hash,rows:{}}};
  const changed = structuredClone(before); changed.command.policy = 'b'.repeat(64);
  assert.throws(() => comparePreservationSnapshots(before, changed), /policy/);
  changed.command = null; assert.throws(() => comparePreservationSnapshots(before, changed), /presence/);
  changed.command = before.command; changed.observedAt = now - 1;
  assert.throws(() => comparePreservationSnapshots(before, changed), /snapshots/);
});
