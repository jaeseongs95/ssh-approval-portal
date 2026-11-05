import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, statSync, linkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CommandOutputs } from '../src/adapters/storage/command-output.mjs';
import { capturePreservationSnapshot, comparePreservationSnapshots } from '../src/adapters/storage/preservation-verification.mjs';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';

// CI/test-server only: durable partial output must never require a command replay.
const binding = { executionId: 'c'.repeat(48), targetId: 'fixture', targetRevision: 'revision' };
const allow = actual => assert.deepEqual(actual, binding);
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-output-stream180-'));
  let store = new CommandOutputs(root, { maxBytes: 4096, budget: 32768, ...options });
  t.after(() => {
    store.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true });
  });
  return { root, get store() { return store; }, restart() { store.close(); store = new CommandOutputs(root, { maxBytes: 4096, budget: 32768, ...options }); },
    path: (item, suffix = '.stream') => join(root, 'command-outputs', item.id + suffix) };
}
const bytes = page => Buffer.concat(page.events.map(event => Buffer.from(event.bytes, page.bytesEncoding)));
const streamState = { receivedBytes: 4, retainedBytes: 4, cursor: 4, truncated: false };
const execution = { phase: 'settled', reason: 'deadline', remoteState: 'unknown', exitCode: null, signal: null, automaticReplay: false, timeoutMs: 120000,
  cleanupComplete: false, requiresReconciliation: true, outputState: 'partial', captureFailed: false, stdout: streamState, stderr: streamState };

test('partial stdout/stderr bytes are durable before finish, paged by cursor, and independent of UTF8 boundaries', t => {
  const f = fixture(t), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  const out = Buffer.from([0xe2, 0x82]), err = Buffer.from([0xac, 0xff, 0]);
  sink.append({ stream: 'stdout', bytes: out, cursor: 0, nextCursor: 2 });
  sink.append({ stream: 'stderr', bytes: err, cursor: 0, nextCursor: 3 });
  let authorizations = 0;
  const first = f.store.readStream({ outputId: item.id, maxBytes: 3 }, value => { allow(value); authorizations++; });
  assert.equal(authorizations, 2); assert.equal(first.state, 'running'); assert.equal(first.eof, false);
  assert.deepEqual(bytes(first), Buffer.from([0xe2, 0x82, 0xac]));
  assert.deepEqual(first.events.map(event => event.stream), ['stdout', 'stderr']);
  const second = f.store.readStream({ outputId: item.id, cursor: first.nextCursor }, allow);
  assert.deepEqual(bytes(second), Buffer.from([0xff, 0])); assert.equal(second.nextCursor, 5);
  assert.throws(() => sink.append({ stream: 'stdout', bytes: Buffer.from('x'), cursor: 0 }), /cursor/);
  f.restart();
  const recovered = f.store.readStream({ outputId: item.id }, allow);
  assert.equal(recovered.complete, true); assert.equal(recovered.state, 'unavailable'); assert.equal(recovered.eof, true);
  assert.deepEqual(bytes(recovered), Buffer.concat([out, err]));
});

test('finish preserves timeout metadata and the legacy immutable snapshot alongside captured bytes', t => {
  const f = fixture(t), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  sink.append({ stream: 'stdout', bytes: Buffer.from('some') }); sink.append({ stream: 'stderr', bytes: Buffer.from('warn') });
  const outcome = { failed: true, texts: ['some', 'warn'], execution };
  const result = f.store.finish(item, outcome);
  assert.deepEqual(result.execution, execution); assert.equal(result.output.state, 'ready');
  assert.equal(result.output.stream.complete, true);
  assert.deepEqual(JSON.parse(f.store.read({ outputId: item.id, format: 'json' }, allow).text), outcome);
  assert.equal(f.store.read({ outputId: item.id, format: 'text' }, allow).text, 'some\nwarn');
  assert.deepEqual(bytes(f.store.readStream({ outputId: item.id }, allow)), Buffer.from('somewarn'));
  assert.throws(() => sink.append({ stream: 'stdout', bytes: Buffer.from('late') }), /closed/);
  const charge = f.store.preservationRows().outputs.find(row => row.id === item.id).charge;
  assert.equal(charge, statSync(f.path(item)).size + statSync(f.path(item, '.out')).size);
  f.restart(); assert.deepEqual(bytes(f.store.readStream({ outputId: item.id }, allow)), Buffer.from('somewarn'));
});

test('finish preserves exit status and signal through durable operation settlement without changing outcome certainty', t => {
  const f = fixture(t), operations = createOperationStore(f.root);
  try {
    const exited = { ...execution, reason: 'exit', remoteState: 'exited', exitCode: 0, signal: null,
      cleanupComplete: true, requiresReconciliation: false, outputState: 'complete' };
    for (const [key, metadata, failed, expectedState] of [
      ['exit-zero', exited, false, 'completed'],
      ['exit-nonzero', { ...exited, exitCode: 7 }, true, 'failed'],
      ['deadline', { ...execution, signal: 'TERM' }, true, 'unknown'],
      ['transport-lost', { ...execution, reason: 'transport_lost' }, true, 'unknown'],
    ]) {
      const job = operations.accept({ requestKey: key, owner: 'owner', targetId: binding.targetId, targetRevision: binding.targetRevision, kind: 'command', input: { command: 'fixture' } });
      operations.update(job.id, { state: 'queued' }); assert.ok(operations.claim(job.id));
      const outcome = { failed, texts: ['captured'], execution: metadata };
      const result = f.store.finish(f.store.reserve({ ...binding, executionId: job.id }), outcome);
      assert.deepEqual(result.execution, metadata);
      const settled = operations.outcome(job.id, result);
      assert.equal(settled.state, expectedState, key); assert.deepEqual(settled.result.execution, metadata);
      assert.deepEqual(JSON.parse(f.store.read({ outputId: result.output.id, format: 'json' }, actual => assert.equal(actual.executionId, job.id)).text), outcome);
    }
  } finally { operations.close(); }
});

test('finish rejects invalid exit status and signal metadata from its public projection', t => {
  const f = fixture(t);
  for (const [exitCode, signal] of [['0', 'PRIVATE secret\n'], [1.5, {}], [Number.MAX_SAFE_INTEGER + 1, 'A'.repeat(33)]]) {
    const result = f.store.finish(f.store.reserve(binding), { failed: true, texts: [], execution: { ...execution, exitCode, signal } });
    assert.equal(Object.hasOwn(result.execution, 'exitCode'), false); assert.equal(Object.hasOwn(result.execution, 'signal'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE secret'), false);
  }
});

test('truncation bounds physical spool bytes, records loss and retains committed bytes after capture failure', t => {
  const f = fixture(t, { maxBytes: 128, budget: 1024 }), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  const result = sink.append({ stream: 'stdout', bytes: Buffer.alloc(200, 97), cursor: 0, nextCursor: 200 });
  assert.equal(result.truncated, true); assert.equal(result.cursor, 123); assert.equal(statSync(f.path(item)).size, 128);
  sink.append({ stream: 'stderr', bytes: Buffer.from('lost'), cursor: 0, nextCursor: 4 });
  assert.equal(statSync(f.path(item)).size, 128);
  const done = f.store.finish(item, { failed: true, texts: ['x'.repeat(200)], execution });
  assert.equal(done.output.state, 'unavailable'); assert.deepEqual(done.execution, execution);
  const page = f.store.readStream({ outputId: item.id }, allow);
  assert.equal(page.truncated, true); assert.equal(page.eof, true); assert.deepEqual(bytes(page), Buffer.alloc(123, 97));
});

test('stream reads reject revocation, damage, hardlinks and expiration, while interrupted tails are ignored', t => {
  let now = 100;
  const f = fixture(t, { now: () => now, ttl: 50 }), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  sink.append({ stream: 'stderr', bytes: Buffer.from('original') });
  assert.throws(() => f.store.readStream({ outputId: item.id }, () => { throw Error('revoked'); }), /revoked/);
  let checks = 0;
  assert.throws(() => f.store.readStream({ outputId: item.id }, () => { if (++checks === 2) throw Error('revoked after read'); }), /revoked/);
  const payload = readFileSync(f.path(item)), damaged = Buffer.from(payload); damaged[5] ^= 1;
  writeFileSync(f.path(item), damaged); assert.throws(() => f.store.readStream({ outputId: item.id }, allow), /integrity/);
  writeFileSync(f.path(item), payload);
  const extra = join(f.root, 'extra-link'); linkSync(f.path(item), extra);
  assert.throws(() => f.store.readStream({ outputId: item.id }, allow), /Unsafe/); unlinkSync(extra);
  appendFileSync(f.path(item), 'uncommitted'); f.restart();
  assert.deepEqual(bytes(f.store.readStream({ outputId: item.id }, allow)), Buffer.from('original'));
  now = 151; assert.throws(() => f.store.readStream({ outputId: item.id }, allow), /expired/);
  f.store.reap(); assert.throws(() => statSync(f.path(item)), { code: 'ENOENT' });
});

test('stream reservation checks its full capacity before dispatch without altering legacy capacity', t => {
  const f = fixture(t, { maxBytes: 1024, budget: 1024 }), item = f.store.reserve(binding);
  assert.throws(() => f.store.beginStream(item), /capacity/);
  assert.equal(f.store.get(item.id).stream, undefined);
  assert.equal(f.store.finish(item, { failed: false, texts: ['legacy'] }).output.state, 'ready');
});

test('a failed manifest checkpoint exposes only the preceding durable cursor and retains uncommitted evidence', t => {
  const f = fixture(t), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  sink.append({ stream: 'stdout', bytes: Buffer.from('committed') });
  const persist = f.store.persist.bind(f.store);
  f.store.persist = (value, charge) => {
    if (value.state === 'pending' && value.stream.bytes > 9) throw Error('checkpoint unavailable');
    return persist(value, charge);
  };
  assert.throws(() => sink.append({ stream: 'stderr', bytes: Buffer.from('uncommitted') }), /checkpoint/);
  const page = f.store.readStream({ outputId: item.id }, allow);
  assert.equal(page.nextCursor, 9); assert.equal(bytes(page).toString(), 'committed');
  assert.ok(statSync(f.path(item)).size > f.store.get(item.id).stream.size);
  f.restart();
  assert.equal(bytes(f.store.readStream({ outputId: item.id }, allow)).toString(), 'committed');
  const charge = f.store.preservationRows().outputs.find(row => row.id === item.id).charge;
  assert.equal(charge, statSync(f.path(item)).size);
});

test('abandon closes the stream without dropping bytes, while finish strips unknown execution properties', t => {
  const f = fixture(t), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  sink.append({ stream: 'stdout', bytes: Buffer.from('before transport loss') });
  f.store.abandon(item);
  const page = f.store.readStream({ outputId: item.id }, allow);
  assert.equal(page.eof, true); assert.equal(page.state, 'unavailable'); assert.equal(bytes(page).toString(), 'before transport loss');
  const result = f.store.finish(f.store.reserve(binding), { failed: true, texts: [], execution: { ...execution, privateError: 'PRIVATE_SENTINEL' } });
  assert.deepEqual(result.execution, execution); assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
});

test('preservation baseline hashes stream bytes including interrupted tails and detects their mutation', t => {
  const f = fixture(t), item = f.store.reserve(binding), sink = f.store.beginStream(item);
  const operationStore = createOperationStore(f.root);
  try {
  sink.append({ stream: 'stdout', bytes: Buffer.from('preserve') });
  f.store.finish(item, { failed: false, texts: ['preserve'] });
  appendFileSync(f.path(item), 'uncommitted tail');
  const before = capturePreservationSnapshot({ outputs: f.store, operationStore, now: 100 });
  assert.ok(before.output.rows[item.id].streamPayload);
  const same = capturePreservationSnapshot({ outputs: f.store, operationStore, now: 101 });
  assert.equal(comparePreservationSnapshots(before, same).status, 'PASS');
  const changed = readFileSync(f.path(item)); changed[changed.length - 1] ^= 1; writeFileSync(f.path(item), changed);
  const after = capturePreservationSnapshot({ outputs: f.store, operationStore, now: 102 });
  assert.throws(() => comparePreservationSnapshots(before, after), /Existing output changed/);
  } finally { operationStore.close(); }
});

test('maintenance retains expired stream bytes and exact accounting without extending read authority', t => {
  let now = 100, maintenance = false;
  const f = fixture(t, { now: () => now, ttl: 50, canReap: () => !maintenance });
  const item = f.store.reserve(binding), sink = f.store.beginStream(item);
  sink.append({ stream: 'stderr', bytes: Buffer.from('retain under maintenance') });
  f.store.finish(item, { failed: false, texts: ['retain under maintenance'] });
  const baseline = f.store.preservationRows(), payload = readFileSync(f.path(item));
  maintenance = true; now = 151; f.store.reap(); f.restart();
  assert.deepEqual(f.store.preservationRows(), baseline); assert.deepEqual(readFileSync(f.path(item)), payload);
  assert.throws(() => f.store.readStream({ outputId: item.id }, allow), /expired/);
  maintenance = false; f.store.reap(); assert.throws(() => statSync(f.path(item)), { code: 'ENOENT' });
});
