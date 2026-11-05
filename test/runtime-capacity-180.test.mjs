import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntimeCapacity } from '../src/application/runtime-capacity.mjs';
import { createRuntimeCapacityState } from '../src/adapters/storage/runtime-capacity-state.mjs';

const settings = { availableCpus: 4, queueCapacity: 40, maxConcurrency: 4, targets: [{ id: 'alpha', queueCapacity: 7, maxConcurrency: null }] };
const targets = [{ id: 'alpha', displayName: 'Alpha' }, { id: 'beta', displayName: 'Beta' }];
const revisions = () => { let count = 0; return () => (++count).toString(16).padStart(32, '0'); };
const scheduler = () => {
  const configurations = [];
  return { configurations, configure: value => configurations.push(structuredClone(value)),
    snapshot: () => ({ queued: 3, active: 2 }), list: () => [{ targetId: 'alpha', state: 'running' }, { targetId: 'alpha', state: 'queued' }],
    cancel: () => assert.fail('Changing capacity must not cancel existing work') };
};

test('runtime capacity persists overrides, inherits globals and shrinks without cancelling existing work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capacity-')), engine = scheduler(); let capacity;
  try {
    capacity = createRuntimeCapacity({ state: createRuntimeCapacityState(root), settings, targets, scheduler: engine, newRevision: revisions() });
    const before = capacity.get();
    assert.deepEqual(before.targets[0].effective, { queueCapacity: 7, maxConcurrency: 4 });
    const shrunk = capacity.set({ expectedRevision: before.revision, settings: { queueCapacity: 1, maxConcurrency: 1 }, targets: [{ id: 'alpha', queueCapacity: null, maxConcurrency: null }] });
    assert.deepEqual(shrunk.status, { queued: 3, running: 2 });
    assert.deepEqual(shrunk.targets[0].effective, { queueCapacity: 1, maxConcurrency: 1 });
    assert.deepEqual(engine.configurations.at(-1), { queueCapacity: 1, globalConcurrency: 1, targetQueueCapacity: { alpha: 1, beta: 1 }, targetConcurrency: { alpha: 1, beta: 1 } });
    capacity.close(); capacity = undefined;
    capacity = createRuntimeCapacity({ state: createRuntimeCapacityState(root), settings: { ...settings, queueCapacity: 80, maxConcurrency: 8 }, targets, scheduler: engine, newRevision: revisions() });
    assert.equal(capacity.get().revision, shrunk.revision);
    assert.deepEqual(capacity.get().settings, { queueCapacity: 1, maxConcurrency: 1 });
    assert.equal(capacity.get().targets[0].queueCapacity, null);
  } finally { capacity?.close(); await rm(root, { recursive: true, force: true }); }
});

test('durable capacity CAS rejects stale handles and maintenance, validation and audit failures do not change limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capacity-cas-')), firstEngine = scheduler(), secondEngine = scheduler();
  let first, second, maintenance = false, failAudit = false;
  try {
    first = createRuntimeCapacity({ state: createRuntimeCapacityState(root), settings, targets, scheduler: firstEngine, newRevision: revisions(), maintenance: () => maintenance, audit: () => { if (failAudit) throw Error('fixture audit failure'); } });
    second = createRuntimeCapacity({ state: createRuntimeCapacityState(root), settings, targets, scheduler: secondEngine, newRevision: revisions() });
    const revision = first.get().revision;
    const saved = first.set({ expectedRevision: revision, settings: { maxConcurrency: 2 } });
    assert.throws(() => first.set({ expectedRevision: revision, settings: { maxConcurrency: 3 } }), { code: 'CAPACITY_REVISION_CONFLICT' });
    assert.throws(() => second.set({ expectedRevision: revision, settings: { maxConcurrency: 3 } }), { code: 'CAPACITY_REVISION_CONFLICT' });
    assert.equal(secondEngine.configurations.length, 1, 'A failed persistent CAS cannot apply stale limits');
    maintenance = true;
    assert.throws(() => first.set({ expectedRevision: saved.revision, settings: { maxConcurrency: 3 } }), /MAINTENANCE_ACTIVE/);
    maintenance = false;
    for (const patch of [{ settings: { queueCapacity: 0 } }, { targets: [null] }, { targets: [{ id: 'missing', maxConcurrency: 1 }] }]) {
      assert.throws(() => first.set({ expectedRevision: saved.revision, ...patch }));
    }
    failAudit = true;
    assert.throws(() => first.set({ expectedRevision: saved.revision, settings: { maxConcurrency: 3 } }), /fixture audit failure/);
    assert.deepEqual(first.get(), saved);
    assert.equal(firstEngine.configurations.length, 2);
    const state = createRuntimeCapacityState(root);
    try { assert.equal(state.read().revision, saved.revision); } finally { state.close(); }
  } finally { first?.close(); second?.close(); await rm(root, { recursive: true, force: true }); }
});

test('malformed persisted capacity closes its state port before scheduler application', () => {
  for (const malformed of [{}, { revision: 'bad', settings: {}, targets: [] },
    { revision: 'a'.repeat(32), settings: { queueCapacity: 1, maxConcurrency: 1 }, targets: [null] },
    { revision: 'a'.repeat(32), settings: { queueCapacity: 1, maxConcurrency: 1 }, targets: [{ id: 'alpha', queueCapacity: 0, maxConcurrency: null }] }]) {
    let closed = false; const engine = scheduler();
    assert.throws(() => createRuntimeCapacity({ state: { read: () => malformed, close: () => { closed = true; } }, settings, targets, scheduler: engine, newRevision: revisions() }));
    assert.equal(closed, true); assert.equal(engine.configurations.length, 0);
  }
});

test('storage adapter rejects malformed JSON and non-private files without replacing their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capacity-invalid-')), path = join(root, 'capacity.sqlite'); let state;
  try {
    state = createRuntimeCapacityState(root); state.close(); state = undefined;
    const db = new DatabaseSync(path);
    try { db.prepare('INSERT INTO runtime_capacity VALUES (1,?)').run('{invalid'); } finally { db.close(); }
    assert.throws(() => createRuntimeCapacity({ state: createRuntimeCapacityState(root), settings, targets, scheduler: scheduler(), newRevision: revisions() }), SyntaxError);
    state = createRuntimeCapacityState(root); assert.throws(() => state.read(), SyntaxError); state.close(); state = undefined;
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      assert.throws(() => createRuntimeCapacityState(root), /UNSAFE_CAPACITY_STORE/);
    }
  } finally { state?.close(); await rm(root, { recursive: true, force: true }); }
});
