import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CommandOutputs } from '../src/adapters/storage/command-output.mjs';
import { executionFailureDetails } from '../src/domain/execution-failure.mjs';

// Storage-only regression plan: retain failure evidence, charge all retained bytes,
// keep in-flight reservations and maintenance baselines, recover old overcharges.
// Real files and SQLite; only write/persist faults are injected. CI execution only.
const binding = { executionId: 'a'.repeat(48), targetId: 'default', profile: 'fixture' };
const limits = { maxBytes: 1024, budget: 8192, ttl: 50, now: () => 100 };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ssh-output-accounting-'));
  let store = new CommandOutputs(root, { ...limits, ...options });
  t.after(() => {
    store?.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, get store() { return store; }, path: (id, suffix = '.part') => join(root, 'command-outputs', id + suffix),
    restart(change = () => {}, nextOptions = options) {
      store.close(); store = undefined; change();
      store = new CommandOutputs(root, { ...limits, ...nextOptions });
      return store;
    },
  };
}
const row = (store, id) => store.preservationRows().outputs.find(value => value.id === id);
function oldCharge(root, id, charge) {
  const db = new DatabaseSync(join(root, 'command-outputs', 'manifest.sqlite'));
  try { db.prepare('UPDATE outputs SET charge=? WHERE id=?').run(charge, id); } finally { db.close(); }
}

function failAfterSevenBytes(t, operation) {
  const original = fs.writeSync;
  let writes = 0;
  const mocked = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    if (writes++) throw Object.assign(Error('synthetic private write failure'), { code: 'EIO' });
    return original(fd, buffer, offset, Math.min(7, length), position);
  });
  syncBuiltinESMExports();
  try { return operation(); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}

test('more than eight failed reservations release empty payload charges without losing records or ready output', t => {
  const f = fixture(t), store = f.store;
  const ready = store.finish(store.reserve(binding), { failed: false, texts: ['retained output'] });
  const readyRow = row(store, ready.output.id), readyBytes = readFileSync(f.path(ready.output.id, '.out'));
  const failedIds = [];
  for (let i = 0; i < 12; i++) {
    const item = store.reserve(binding);
    assert.equal(row(store, item.id).charge, limits.maxBytes, 'in-flight work still reserves its maximum');
    store.abandon(item); failedIds.push(item.id);
    assert.equal(row(store, item.id).charge, 0);
    assert.equal(store.get(item.id).state, 'unavailable');
    assert.deepEqual(store.get(item.id).binding, binding);
    assert.equal(readFileSync(f.path(item.id)).length, 0);
    assert.throws(() => store.read({ outputId: item.id }, () => {}), /unavailable/);
  }
  assert.deepEqual(row(store, ready.output.id), readyRow);
  assert.deepEqual(readFileSync(f.path(ready.output.id, '.out')), readyBytes);
  assert.equal(store.read({ outputId: ready.output.id }, () => {}).text, 'retained output');
  const success = store.finish(store.reserve(binding), { failed: false, texts: ['after failures'] });
  assert.equal(success.output.state, 'ready');
  assert.equal(store.preservationRows().outputs.length, failedIds.length + 2);
  f.restart();
  for (const id of failedIds) assert.equal(row(f.store, id).charge, 0);
  assert.deepEqual(readFileSync(f.path(ready.output.id, '.out')), readyBytes);
});

test('partial write and unavailable persistence failure keep bytes charged across restart', t => {
  for (const persistenceFails of [false, true]) {
    const f = fixture(t), item = f.store.reserve(binding), persist = f.store.persist.bind(f.store);
    if (persistenceFails) f.store.persist = (value, charge) => {
      if (value.state === 'unavailable') throw Error('synthetic private manifest failure');
      return persist(value, charge);
    };
    const result = failAfterSevenBytes(t, () => f.store.finish(item, { failed: false, texts: ['retain partial evidence'] }));
    assert.equal(result.failed, false, 'capture failure does not change the execution outcome');
    assert.equal(result.output.state, 'unavailable');
    assert.deepEqual(result.failure, { stage: 'output_capture', code: 'OUTPUT_CAPTURE_FAILED', remoteOutcome: 'completed', automaticReplay: false });
    assert.equal(JSON.stringify(result).includes('private'), false);
    const bytes = readFileSync(f.path(item.id)); assert.equal(bytes.length, 7);
    assert.equal(row(f.store, item.id).charge, persistenceFails ? limits.maxBytes : 7);
    f.restart();
    assert.equal(f.store.get(item.id).state, 'unavailable');
    assert.equal(row(f.store, item.id).charge, 7);
    assert.deepEqual(readFileSync(f.path(item.id)), bytes);
    assert.throws(() => f.store.read({ outputId: item.id }, () => {}), /unavailable/);
  }
});

test('publication persistence failure retains the complete payload and its actual charge', t => {
  const f = fixture(t), item = f.store.reserve(binding), persist = f.store.persist.bind(f.store);
  f.store.persist = (value, charge) => {
    if (value.state === 'ready') throw Error('synthetic publication failure');
    return persist(value, charge);
  };
  const result = f.store.finish(item, { failed: true, texts: ['complete retained payload'] });
  const bytes = readFileSync(f.path(item.id, '.out'));
  assert.equal(result.failed, true); assert.equal(result.output.state, 'unavailable');
  assert.equal(result.failure.code, 'OUTPUT_CAPTURE_FAILED');
  assert.equal(row(f.store, item.id).charge, bytes.length);
  f.restart();
  assert.deepEqual(readFileSync(f.path(item.id, '.out')), bytes);
  assert.equal(row(f.store, item.id).charge, bytes.length);
});

test('restart reconciles old unavailable and interrupted reservations, preserving expiry, both files and schema', t => {
  let now = 100;
  const f = fixture(t, { now: () => now }), old = f.store.reserve(binding), interrupted = f.store.reserve(binding);
  f.store.abandon(old);
  writeFileSync(f.path(old.id), 'partial evidence');
  writeFileSync(f.path(old.id, '.out'), 'published evidence', { mode: 0o600 });
  writeFileSync(f.path(interrupted.id), 'interrupted evidence');
  const original = f.store.get(old.id), schema = f.store.preservationRows().schema;
  now = 120;
  f.restart(() => oldCharge(f.root, old.id, limits.maxBytes));
  assert.deepEqual(f.store.get(old.id), original, 'accounting alone does not rewrite the failure manifest');
  assert.equal(row(f.store, old.id).charge, Buffer.byteLength('partial evidencepublished evidence'));
  assert.equal(f.store.get(interrupted.id).state, 'unavailable');
  assert.equal(f.store.get(interrupted.id).expiresAt, 150, 'restart does not renew retention');
  assert.equal(row(f.store, interrupted.id).charge, Buffer.byteLength('interrupted evidence'));
  assert.deepEqual(f.store.preservationRows().schema, schema);
  const charged = row(f.store, old.id).charge;
  f.restart(() => writeFileSync(f.path(old.id), 'cut'));
  assert.ok(row(f.store, old.id).charge < charged);
  assert.equal(row(f.store, old.id).charge, Buffer.byteLength('cutpublished evidence'));
  assert.equal(readFileSync(f.path(old.id)).toString(), 'cut');
  now = 151; f.store.reap();
  assert.equal(f.store.preservationRows().outputs.length, 0);
  assert.throws(() => readFileSync(f.path(old.id)), { code: 'ENOENT' });
  assert.throws(() => readFileSync(f.path(old.id, '.out')), { code: 'ENOENT' });
});

test('maintenance preserves old charges and exact rows until normal reserve can reconcile them', t => {
  let maintenance = false;
  const options = { canReap: () => !maintenance, budget: limits.maxBytes };
  const f = fixture(t, options), item = f.store.reserve(binding);
  f.store.abandon(item);
  maintenance = true;
  f.restart(() => oldCharge(f.root, item.id, limits.maxBytes));
  const baseline = f.store.preservationRows(), bytes = readFileSync(f.path(item.id));
  f.store.reap();
  assert.deepEqual(f.store.preservationRows(), baseline);
  assert.throws(() => f.store.reserve(binding), /capacity/);
  assert.deepEqual(f.store.preservationRows(), baseline);
  f.restart();
  assert.deepEqual(f.store.preservationRows(), baseline);
  assert.deepEqual(readFileSync(f.path(item.id)), bytes);
  maintenance = false;
  const next = f.store.reserve(binding);
  assert.equal(row(f.store, item.id).charge, 0);
  assert.equal(row(f.store, next.id).charge, limits.maxBytes);
  f.store.abandon(next);
});

test('missing and unsafe payload evidence conservatively retains the reservation; oversize bytes are fully charged', t => {
  for (const kind of ['missing', 'hardlink', 'oversize']) {
    const f = fixture(t), item = f.store.reserve(binding);
    if (kind === 'missing') unlinkSync(f.path(item.id));
    if (kind === 'hardlink') linkSync(f.path(item.id), join(f.root, 'unsafe-extra-link'));
    if (kind === 'oversize') writeFileSync(f.path(item.id), Buffer.alloc(limits.maxBytes + 7, 0x78));
    f.store.abandon(item);
    const expected = kind === 'oversize' ? limits.maxBytes + 7 : limits.maxBytes;
    assert.equal(row(f.store, item.id).charge, expected);
    f.restart();
    assert.equal(row(f.store, item.id).charge, expected);
    assert.equal(f.store.get(item.id).state, 'unavailable');
  }
});

test('oversize capture releases an untouched payload reservation and exposes only safe failure metadata', t => {
  const f = fixture(t, { budget: limits.maxBytes });
  const result = f.store.finish(f.store.reserve(binding), { failed: false, texts: ['x'.repeat(limits.maxBytes)] });
  assert.equal(result.output.state, 'unavailable'); assert.equal(result.failed, false);
  assert.equal(result.failure.remoteOutcome, 'completed'); assert.equal(result.failure.automaticReplay, false);
  assert.equal(row(f.store, result.output.id).charge, 0);
  const active = f.store.reserve(binding);
  assert.throws(() => f.store.reserve(binding), error => {
    assert.match(error.message, /capacity/);
    assert.deepEqual(executionFailureDetails(error), { stage: 'output_reservation', code: 'OUTPUT_CAPACITY', remoteOutcome: 'not_started', automaticReplay: false });
    return true;
  });
  f.store.abandon(active);
});

test('ready captures retain safe executor diagnostics without changing output bytes or blessing invalid metadata', t => {
  const f = fixture(t), failure = { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED', remoteOutcome: 'unknown', automaticReplay: false };
  const outcome = { failed: true, texts: ['original failure evidence'], failure };
  const result = f.store.finish(f.store.reserve(binding), outcome);
  assert.equal(result.output.state, 'ready'); assert.equal(result.failed, true); assert.deepEqual(result.failure, failure);
  assert.deepEqual(JSON.parse(f.store.read({ outputId: result.output.id, format: 'json' }, () => {}).text), outcome);
  const invalid = f.store.finish(f.store.reserve(binding), { failed: false, texts: ['normal output'], failure: { ...failure, code: 'PRIVATE_UNRECOGNIZED_CODE' } });
  assert.equal(invalid.output.state, 'ready'); assert.equal(invalid.failure, undefined);
});
