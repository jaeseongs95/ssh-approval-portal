import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createOperationScheduler } from '../src/domain/operation-scheduler.mjs';

// Execute these checks on TEST/Actions, never as local product tests.
const tick = () => new Promise(resolve => setImmediate(resolve));
const exited = { failed: false, execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', cleanupComplete: true, requiresReconciliation: false, exitCode: 0 } };
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'operations-scheduler-')), store = createOperationStore(root);
  const starts = [], controls = new Map();
  const scheduler = createOperationScheduler({ store, globalConcurrency: 1, unknownBudget: 32, ...options,
    execute: async job => { starts.push(job.requestKey); const control = Promise.withResolvers(); controls.set(job.requestKey, { ...control, signal: job.signal }); return control.promise; } });
  const enqueue = (requestKey, targetId = 'alpha', extra = {}) => scheduler.enqueue({ requestKey, targetId, owner: 'owner', targetRevision: 'rev1', kind: 'command', input: { command: requestKey }, ...extra });
  t.after(async () => {
    scheduler.configure({ paused: true });
    for (const control of controls.values()) control.resolve(exited);
    await tick(); scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  return { store, scheduler, starts, controls, enqueue, release: (key, outcome = exited) => controls.get(key).resolve(outcome) };
}

test('one ready-target ring provides round robin fairness and target FIFO across operation kinds', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const jobs = [f.enqueue('a1'), f.enqueue('a2'), f.enqueue('a3'), f.enqueue('b1', 'beta', { kind: 'upload' }), f.enqueue('b2', 'beta'), f.enqueue('c1', 'gamma', { kind: 'cli' })];
  await tick(); assert.deepEqual(f.starts, ['a1']);
  for (const key of ['a1', 'b1', 'c1', 'a2', 'b2', 'a3']) { assert.equal(f.starts.at(-1), key); f.release(key); await tick(); }
  assert.deepEqual(f.starts, ['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  assert.ok(jobs.every(job => f.store.get(job.id).state === 'completed'));
});

test('duplicate enqueue never dispatches twice and key conflicts reject before effects', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.enqueue('same');
  assert.equal(f.enqueue('same').id, first.id);
  assert.throws(() => f.enqueue('same', 'alpha', { input: { command: 'changed' } }), { code: 'OPERATION_KEY_CONFLICT' });
  await tick(); f.release('same'); await f.scheduler.observe(first.id);
  assert.equal(f.enqueue('same').id, first.id); await tick(); assert.deepEqual(f.starts, ['same']);
});

test('unknown blocks one conflict key while independent work continues on the same target', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.enqueue('installer', 'alpha', { conflictKey: 'install' });
  await tick(); f.release('installer', { failed: true, execution: { ...exited.execution, remoteState: 'unknown', requiresReconciliation: true } });
  await f.scheduler.observe(first.id);
  const fenced = f.enqueue('fenced', 'alpha', { conflictKey: 'install' }), independent = f.enqueue('independent');
  await tick(); assert.deepEqual(f.starts, ['installer', 'independent']);
  assert.equal(f.store.get(fenced.id).state, 'queued');
  f.release('independent'); assert.equal((await f.scheduler.observe(independent.id)).state, 'completed');
  assert.equal(f.scheduler.enqueue(first.id).state, 'unknown'); assert.deepEqual(f.starts, ['installer', 'independent']);
});

test('33 retained legacy unknowns stay visible without consuming admission or dispatch capacity', { timeout: 5000 }, async t => {
  const f = fixture(t), source = 'command-automation.sqlite';
  const list = f.store.list;
  f.store.list = filter => {
    assert.ok(filter?.state || filter?.states, 'scheduler hot paths must not load all retained history bodies');
    return list(filter);
  };
  const waiting = f.enqueue('queued-before-history', 'alpha', { conflictKey: 'legacy-resource' });
  const imported = Array.from({ length: 33 }, (_, index) => f.store.importLegacy({
    id: (index + 1).toString(16).padStart(48, '0'), state: 'running', kind: 'command',
    targetId: 'alpha', targetRevision: 'rev1', conflictKey: 'legacy-resource',
    operation: { kind: 'command', command: 'historical-only' },
  }, { source }));
  const events = imported.map(job => f.store.events(job.id));
  assert.equal(f.scheduler.snapshot().unknown, 33, 'public history count still includes migrated unknowns');
  assert.ok(imported.every(job => job.conflictKey === undefined && job.legacy.original.conflictKey === 'legacy-resource'));
  const fresh = f.enqueue('new-after-history', 'alpha', { conflictKey: 'legacy-resource' });
  await tick(); assert.deepEqual(f.starts, ['queued-before-history']);
  f.release('queued-before-history'); await f.scheduler.observe(waiting.id); await tick();
  assert.deepEqual(f.starts, ['queued-before-history', 'new-after-history']);
  f.release('new-after-history'); assert.equal((await f.scheduler.observe(fresh.id)).state, 'completed');
  assert.equal(f.scheduler.enqueue(imported[0].id).state, 'unknown', 'history never authorizes replay');
  for (const [index, job] of imported.entries()) {
    assert.deepEqual(f.store.get(job.id), job); assert.deepEqual(f.store.events(job.id), events[index]);
  }
  assert.equal(f.scheduler.snapshot().unknown, 33);
  assert.deepEqual(f.starts, ['queued-before-history', 'new-after-history']);
});

test('live unknowns still exhaust the shared budget and stop queued dispatch beside retained history', { timeout: 5000 }, async t => {
  const f = fixture(t, { unknownBudget: 2 });
  for (let index = 0; index < 33; index++) f.store.importLegacy({
    id: (index + 1).toString(16).padStart(48, '0'), state: 'running', kind: 'command',
    operation: { kind: 'command', command: 'historical-only' },
  }, { source: 'command-automation.sqlite' });
  const one = f.enqueue('live-one'), two = f.enqueue('live-two'), waiting = f.enqueue('still-queued');
  const unknown = { failed: true, execution: { ...exited.execution, remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true } };
  await tick(); assert.deepEqual(f.starts, ['live-one']);
  f.release('live-one', unknown); assert.equal((await f.scheduler.observe(one.id)).state, 'unknown'); await tick();
  assert.deepEqual(f.starts, ['live-one', 'live-two']);
  f.release('live-two', unknown); assert.equal((await f.scheduler.observe(two.id)).state, 'unknown'); await tick();
  assert.equal(f.scheduler.snapshot().unknown, 35, 'history and live unknowns remain observable together');
  assert.equal(f.store.get(waiting.id).state, 'queued', 'live risk budget still fences durable claims');
  assert.throws(() => f.enqueue('over-live-budget'), { code: 'OPERATION_RECONCILIATION_CAPACITY', accepted: false });
  assert.equal(f.store.find('over-live-budget'), null);
  assert.deepEqual(f.starts, ['live-one', 'live-two']);
});

test('partial legacy markers do not exempt a live unknown from admission risk', { timeout: 5000 }, async t => {
  const id = 'f'.repeat(48), source = 'command-automation.sqlite';
  for (const extra of [
    { recoveryReason: 'bridge_restart', legacy: { source, original: { id } } },
    { recoveryReason: 'legacy_import', legacy: { source: null, original: { id } } },
    { recoveryReason: 'legacy_import', legacy: { source, original: { id: 'different' } } },
  ]) {
    const f = fixture(t, { unknownBudget: 1 }), job = f.enqueue('live-marker', 'alpha', { id, ...extra });
    await tick(); f.release('live-marker', { failed: true, execution: { ...exited.execution, remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true } });
    assert.equal((await f.scheduler.observe(job.id)).state, 'unknown');
    assert.throws(() => f.enqueue('blocked'), { code: 'OPERATION_RECONCILIATION_CAPACITY', accepted: false });
    assert.equal(f.store.find('blocked'), null); assert.deepEqual(f.starts, ['live-marker']);
  }
});

test('shrinking capacity preserves running and accepted work; overload is typed and unaccepted', { timeout: 5000 }, async t => {
  const f = fixture(t, { globalConcurrency: 2, targetConcurrency: 2, queueCapacity: 4, targetQueueCapacity: { alpha: 3, beta: 1 } });
  const one = f.enqueue('one'), two = f.enqueue('two'); await tick(); assert.deepEqual(f.starts, ['one', 'two']);
  const three = f.enqueue('three'), four = f.enqueue('four');
  f.scheduler.configure({ globalConcurrency: 1, targetConcurrency: 1, queueCapacity: 1 });
  assert.equal(f.controls.get('one').signal.aborted, false); assert.equal(f.controls.get('two').signal.aborted, false);
  assert.throws(() => f.enqueue('overflow'), { code: 'OPERATION_QUEUE_FULL', accepted: false }); assert.equal(f.store.find('overflow'), null);
  f.release('one'); await f.scheduler.observe(one.id); await tick(); assert.deepEqual(f.starts, ['one', 'two']);
  f.release('two'); await f.scheduler.observe(two.id); await tick(); assert.equal(f.starts.at(-1), 'three');
  f.release('three'); await f.scheduler.observe(three.id); await tick(); f.release('four'); await f.scheduler.observe(four.id);
});

test('observation timeout/abort never cancels execution; explicit queued cancellation has no effects', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.enqueue('first'), queued = f.enqueue('queued'); await tick();
  const observer = new AbortController(), waiting = f.scheduler.observe(first.id, { signal: observer.signal });
  observer.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(f.controls.get('first').signal.aborted, false);
  assert.equal((await f.scheduler.observe(first.id, { timeoutMs: 1 })).state, 'running');
  assert.equal(f.scheduler.cancel(queued.id).state, 'cancelled');
  f.release('first'); await f.scheduler.observe(first.id); await tick(); assert.deepEqual(f.starts, ['first']);
});

test('running cancellation remains terminating until typed remote settlement', { timeout: 5000 }, async t => {
  const f = fixture(t), job = f.enqueue('running'); await tick();
  assert.equal(f.scheduler.cancel(job.id).state, 'terminating'); assert.equal(f.controls.get('running').signal.aborted, true);
  f.release('running', { failed: true, execution: { ...exited.execution, reason: 'cancel' } });
  assert.equal((await f.scheduler.observe(job.id)).state, 'cancelled');
});

test('approval terminal transitions wake registered observers without executing the operation', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const accepted = f.store.accept({ requestKey: 'approval', owner: 'owner', targetId: 'alpha', targetRevision: 'rev1', kind: 'command', input: { command: 'approval' } });
  const observing = f.scheduler.observe(accepted.id);
  f.scheduler.transition(accepted.id, { state: 'denied' }, { expectedVersion: accepted.version });
  assert.equal((await observing).state, 'denied'); await tick(); assert.deepEqual(f.starts, []);
});

test('queued expiry wakes while the occupied execution slot remains running', { timeout: 5000 }, async t => {
  let time = 0;
  const f = fixture(t, { now: () => time });
  f.enqueue('long'); const queued = f.enqueue('expiring', 'alpha', { expiresAt: 10 });
  await tick(); time = 20;
  assert.equal((await f.scheduler.observe(queued.id, { timeoutMs: 1000 })).state, 'expired');
  assert.deepEqual(f.starts, ['long']); assert.equal(f.controls.get('long').signal.aborted, false);
});

test('expiry during a dispatch guard still prevents the executor from starting', { timeout: 5000 }, async t => {
  let time = 0;
  const guard = Promise.withResolvers(), f = fixture(t, { now: () => time, beforeDispatch: () => guard.promise });
  const job = f.enqueue('guarded', 'alpha', { expiresAt: 10 });
  await tick(); assert.equal(f.store.get(job.id).state, 'starting');
  time = 20; guard.resolve();
  assert.equal((await f.scheduler.observe(job.id)).state, 'expired'); assert.deepEqual(f.starts, []);
});

test('safe integer capacity has no arbitrary cap and the default risk budget follows global concurrency', t => {
  const root = mkdtempSync(join(tmpdir(), 'operations-capacity-')), store = createOperationStore(root);
  const scheduler = createOperationScheduler({ store, globalConcurrency: 10001, execute: async () => exited });
  t.after(() => { scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(scheduler.snapshot().globalConcurrency, 10001); assert.equal(scheduler.snapshot().unknownBudget, 10001);
  scheduler.configure({ globalConcurrency: 20001, queueCapacity: 50001 });
  assert.equal(scheduler.snapshot().unknownBudget, 20001);
  scheduler.configure({ unknownBudget: 4, globalConcurrency: 30001 });
  assert.equal(scheduler.snapshot().unknownBudget, 4, 'an explicitly chosen shared risk budget remains authoritative');
});

test('guard refusal is not dispatched and notification errors cannot strand the next job', { timeout: 5000 }, async t => {
  const f = fixture(t, { beforeDispatch: job => { if (job.requestKey === 'refused') throw Error('policy changed'); }, onChange: () => { throw Error('observer failed'); } });
  const refused = f.enqueue('refused'), next = f.enqueue('next');
  assert.equal((await f.scheduler.observe(refused.id)).state, 'failed'); await tick(); assert.deepEqual(f.starts, ['next']);
  f.release('next'); assert.equal((await f.scheduler.observe(next.id)).state, 'completed');
});

test('queued restart checks the original expiry and running restart never calls execute again', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'operations-restart-')); let store = createOperationStore(root);
  const record = key => ({ requestKey: key, owner: 'owner', targetId: 'alpha', targetRevision: 'rev1', kind: 'command', input: { command: key }, expiresAt: 100 });
  const waiting = store.accept(record('waiting')); store.update(waiting.id, { state: 'queued' });
  const active = store.accept(record('active')); store.update(active.id, { state: 'queued' }); store.claim(active.id);
  store.close(); store = createOperationStore(root); const effects = [];
  const scheduler = createOperationScheduler({ store, now: () => 101, execute: async job => { effects.push(job.id); return exited; } });
  t.after(() => { scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await tick(); assert.equal(store.get(waiting.id).state, 'expired'); assert.equal(store.get(active.id).state, 'unknown'); assert.deepEqual(effects, []);
});
