import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';

// Product checks run on TEST/Actions; no local product execution is authorized.
const record = (requestKey, extra = {}) => ({ requestKey, owner: 'owner', targetId: 'alpha', targetRevision: 'rev1', kind: 'command', input: { command: 'printf ok' }, ...extra });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'operations-store-'));
  let store = createOperationStore({ filePath: join(root, 'operations.sqlite'), ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = createOperationStore({ filePath: join(root, 'operations.sqlite'), ...options }); return store; } };
}
const exited = { failed: false, execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', cleanupComplete: true, requiresReconciliation: false, exitCode: 0 } };

test('durable acceptance returns one identity for equal contracts and rejects changed bytes/owner/pins', t => {
  const f = fixture(t), value = record('same'), first = f.store.accept(value);
  value.input.command = 'changed after acceptance';
  assert.equal(f.store.get(first.id).input.command, 'printf ok');
  assert.equal(f.store.accept(record('same')).id, first.id);
  for (const extra of [{ input: { command: 'printf ok ' } }, { owner: 'other' }, { targetRevision: 'rev2' }, { deadline: 123 }]) {
    assert.throws(() => f.store.accept(record('same', extra)), { code: 'OPERATION_KEY_CONFLICT' });
  }
  assert.equal(f.reopen().find('same').job.id, first.id);
  assert.deepEqual(f.store.events(first.id).map(event => event.state), ['accepted']);
});

test('optimistic claims persist before dispatch and cannot be acquired twice', t => {
  const { store } = fixture(t), job = store.accept(record('claim'));
  const queued = store.update(job.id, { state: 'queued' }, { expectedVersion: 1 });
  assert.equal(store.claim(job.id, { expectedVersion: 1 }), null);
  const claimed = store.claim(job.id, { expectedVersion: queued.version });
  assert.equal(claimed.state, 'starting');
  assert.equal(store.get(job.id).state, 'starting');
  assert.equal(store.claim(job.id, { expectedVersion: queued.version }), null);
  assert.throws(() => store.update(job.id, { state: 'running' }, { expectedVersion: queued.version }), { code: 'OPERATION_VERSION_CONFLICT' });
  for (const patch of [{ input: { command: 'other' } }, { targetRevision: 'rev2' }, { deadline: 999 }, { expiresAt: 999 }]) {
    assert.throws(() => store.update(job.id, patch), { code: 'OPERATION_CONTRACT_IMMUTABLE' });
  }
});

test('restart preserves queued contracts and isolates dispatched attempts as unknown without replay', t => {
  const f = fixture(t);
  const queue = f.store.accept(record('queue', { deadline: 10000, policyRevision: 7, approval: { mode: 'owner' } }));
  f.store.update(queue.id, { state: 'queued' });
  const active = f.store.accept(record('active', { targetId: 'beta' }));
  f.store.update(active.id, { state: 'queued' }); f.store.claim(active.id);
  const original = f.store.get(queue.id);
  f.reopen(); const recovered = f.store.recover();
  assert.deepEqual(recovered.map(job => job.id), [active.id]);
  assert.deepEqual(f.store.get(queue.id), original);
  assert.equal(f.store.get(active.id).state, 'unknown');
  assert.equal(f.store.claim(active.id), null);
  assert.deepEqual(f.store.recover(), []);
});

test('typed remote evidence determines terminal outcome; a resolved legacy promise proves nothing', t => {
  const { store } = fixture(t);
  for (const [key, outcome, state] of [['exit', exited, 'completed'], ['legacy', { failed: false }, 'unknown'],
    ['lost', { failed: true, execution: { ...exited.execution, remoteState: 'unknown', requiresReconciliation: true } }, 'unknown'],
    ['cleanup', { failed: false, execution: { ...exited.execution, cleanupComplete: false } }, 'unknown']]) {
    const job = store.accept(record(key)); store.update(job.id, { state: 'queued' });
    assert.ok(store.claim(job.id)); assert.equal(store.outcome(job.id, outcome).state, state);
  }
});

test('legacy import preserves exact old identity/evidence/output and never executes old queued rows', t => {
  const { store } = fixture(t);
  const completed = { id: 'old-completed', operation: { kind: 'command', command: 'old bytes' }, state: 'completed', createdAt: 100, finishedAt: 200, result: { texts: ['legacy'] } };
  const imported = store.importLegacy(completed, { source: 'commands', requestKey: 'old-key', digest: 'old-digest' });
  assert.equal(imported.state, 'completed'); assert.equal(imported.id, completed.id);
  assert.deepEqual(imported.legacy.original, completed);
  assert.deepEqual(imported.outputRef, { requestId: completed.id });
  assert.deepEqual(store.importLegacy(completed, { source: 'commands', requestKey: 'old-key', digest: 'old-digest' }), imported);
  assert.throws(() => store.importLegacy({ ...completed, state: 'failed' }, { source: 'commands', requestKey: 'old-key', digest: 'old-digest' }), { code: 'OPERATION_KEY_CONFLICT' });
  const queued = store.importLegacy({ ...completed, id: 'old-queued', state: 'queued' }, { source: 'cli' });
  assert.equal(queued.state, 'unknown'); assert.equal(store.claim(queued.id), null);
});

test('explicit conflict keys serialize active work and quarantine only their target revision', t => {
  const { store } = fixture(t);
  const make = (key, extra = {}) => { const job = store.accept(record(key, { conflictKey: 'installer', ...extra })); return store.update(job.id, { state: 'queued' }); };
  const first = make('first'), second = make('second'), other = make('other', { conflictKey: 'independent' }), revised = make('revised', { targetRevision: 'rev2' });
  const limits = { globalConcurrency: 10, targetConcurrency: 10 };
  assert.ok(store.claim(first.id, limits)); assert.equal(store.claim(second.id, limits), null);
  store.outcome(first.id, { failed: true });
  assert.equal(store.claim(second.id, limits), null);
  assert.ok(store.claim(other.id, limits)); assert.ok(store.claim(revised.id, limits));
});

test('unknown budget reserves every active attempt and journal budget refuses new records explicitly', t => {
  const { store } = fixture(t, { maxRows: 3 });
  const jobs = ['one', 'two', 'three'].map(key => { const job = store.accept(record(key)); return store.update(job.id, { state: 'queued' }); });
  const limits = { globalConcurrency: 10, targetConcurrency: 10, unknownBudget: 1 };
  assert.ok(store.claim(jobs[0].id, limits)); assert.equal(store.claim(jobs[1].id, limits), null);
  store.outcome(jobs[0].id, { failed: false });
  assert.equal(store.claim(jobs[1].id, limits), null);
  assert.throws(() => store.accept(record('overflow')), { code: 'OPERATION_CAPACITY' });
  assert.equal(store.find('overflow'), null);
});
