import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeCapacity } from '../src/application/runtime-capacity.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-capacity-180-'));
  const instances = [];
  t.after(() => { for (const instance of instances) instance.close(); rmSync(root, { recursive: true, force: true }); });
  const calls = [], jobs = [{ targetId: 'linux', state: 'running' }, { targetId: 'linux', state: 'queued' }];
  const scheduler = { configure: value => calls.push(structuredClone(value)), snapshot: () => ({ queued: 1, active: 1 }), list: () => jobs };
  const settings = { availableCpus: 2, queueCapacity: 20, maxConcurrency: 2, targets: [{ id: 'linux' }, { id: 'windows', maxConcurrency: 1 }] };
  const open = (ids = ['linux', 'windows'], extra = {}) => {
    const instance = createRuntimeCapacity({ root, settings, targets: ids.map(id => ({ id, displayName: id })), scheduler, ...extra });
    instances.push(instance);
    return instance;
  };
  const close = instance => { instance.close(); instances.splice(instances.indexOf(instance), 1); };
  return { open, close, calls, jobs };
}

test('administrator overrides persist with CAS and nullable inheritance across restart', t => {
  const { open, close, calls } = fixture(t);
  let service = open(), first = service.get();
  assert.deepEqual(first.settings, { queueCapacity: 20, maxConcurrency: 2 });
  assert.equal(first.targets[1].maxConcurrency, 1);
  const saved = service.set({ expectedRevision: first.revision, settings: { queueCapacity: 3, maxConcurrency: 1 }, targets: [{ id: 'windows', maxConcurrency: null }] });
  assert.throws(() => service.set({ expectedRevision: first.revision, settings: { maxConcurrency: 9 } }), { code: 'CAPACITY_REVISION_CONFLICT' });
  assert.equal(calls.at(-1).targetConcurrency.windows, 1);
  close(service); service = open();
  assert.deepEqual(service.get(), saved);
});

test('removing a configured target retains its override without blocking startup or changing other targets', t => {
  const { open, close } = fixture(t);
  let service = open();
  service.set({ expectedRevision: service.get().revision, targets: [{ id: 'windows', queueCapacity: 7 }] });
  close(service); service = open(['linux']);
  assert.deepEqual(service.get().targets.map(target => target.id), ['linux']);
  service.set({ expectedRevision: service.get().revision, settings: { maxConcurrency: 3 } });
  assert.throws(() => service.set({ expectedRevision: service.get().revision, targets: [{ id: 'absent', maxConcurrency: 1 }] }), /UNKNOWN_CAPACITY_TARGET/);
  close(service); service = open();
  assert.equal(service.get().targets.find(target => target.id === 'windows').queueCapacity, 7);
});

test('shrinking limits does not mutate active jobs, and malformed settings or maintenance writes do not save', t => {
  const { open, calls, jobs } = fixture(t);
  let maintenance = false;
  const service = open(undefined, { maintenance: () => maintenance });
  const beforeJobs = structuredClone(jobs);
  service.set({ expectedRevision: service.get().revision, settings: { queueCapacity: 1, maxConcurrency: 1 } });
  assert.deepEqual(jobs, beforeJobs);
  assert.equal(calls.at(-1).globalConcurrency, 1);
  const saved = service.get();
  for (const settings of [[], 3, true, 'bad', null, { maxConcurrency: 0 }]) {
    assert.throws(() => service.set({ expectedRevision: saved.revision, settings }));
    assert.deepEqual(service.get(), saved);
  }
  maintenance = true;
  assert.throws(() => service.set({ expectedRevision: saved.revision, settings: { maxConcurrency: 4 } }), /MAINTENANCE_ACTIVE/);
  assert.deepEqual(service.get(), saved);
});
