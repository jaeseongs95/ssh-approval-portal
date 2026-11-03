import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';
import { createOperationScheduler } from '../src/domain/operation-scheduler.mjs';
import { createFileService } from '../src/application/files.mjs';

const revision = 'a'.repeat(64), source = 'command-automation.sqlite';
const terminal = new Set(['completed', 'failed', 'denied', 'expired', 'cancelled', 'unknown']);
const outcome = { failed: false, texts: ['done'], execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', exitCode: 0, cleanupComplete: true, requiresReconciliation: false } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-restore-'));
  const f = { root, store: createOperationStore(root), commands: createCommandState(root), audits: [], cleanups: [], saves: [] };
  t.after(async () => { f.scheduler?.close(); f.store.close(); f.commands.close(); await rm(root, { recursive: true, force: true }); });
  f.queue = options => new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'writer', target: 'fixture',
    identity: { targetId: 'fixture', targetRevision: revision }, operationStore: f.store,
    audit: event => f.audits.push(event), onTerminal: job => f.cleanups.push(job.id),
    executeOperation: async () => assert.fail('restored operations must not execute'), ...options });
  f.seed = (state, n = 1, operation = { kind: 'command', command: 'fixture command' }) => {
    const job = { id: String(n).padStart(48, '0'), state, targetId: 'fixture', targetRevision: revision,
      kind: operation.kind, operation, profile: 'writer', commandClass: 'privileged', target: 'fixture',
      createdAt: 100, expiresAt: 10000, finishedAt: 200, result: { failed: state === 'failed', texts: ['retained result'] } };
    f.commands.insert(job, `legacy-key-${n}`, `digest-${n}`);
    f.store.importLegacy(job, { source, requestKey: `legacy-key-${n}`, digest: `digest-${n}` });
    return job;
  };
  return f;
}
function observe(queue, id) {
  const counts = { notified: 0, resolved: 0 }, job = queue.jobs.get(id), resolve = job.resolveCompletion;
  queue.requestWaiters.add({ id, notify: value => { if (terminal.has(value.state)) counts.notified++; } });
  job.resolveCompletion = value => { counts.resolved++; resolve?.(value); };
  return counts;
}

test('startup restores terminal command history without rewriting operation versions, events, legacy bodies or audits', async t => {
  const f = await fixture(t), jobs = [...terminal].map((state, n) => f.seed(state, n + 1));
  f.store.close(); f.commands.close();
  f.store = createOperationStore(f.root); f.commands = createCommandState(f.root);
  const before = jobs.map(job => ({ record: f.store.get(job.id), events: f.store.events(job.id) }));
  const legacy = f.commands.preservationRows(), queue = f.queue();
  for (const job of jobs) {
    queue.restore(f.commands.find(`legacy-key-${Number(job.id)}`).job, value => { f.saves.push(value); f.commands.save(value); });
    const calls = observe(queue, job.id), record = f.store.get(job.id);
    queue.syncOperation(record, { restoring: true }); queue.syncOperation(record);
    assert.deepEqual(queue.get(job.id).result, job.result);
    assert.equal(queue.get(job.id).state, job.state); assert.equal(queue.get(job.id).finishedAt, 200);
    assert.deepEqual(calls, { notified: 1, resolved: 1 });
    assert.equal((await queue.wait(job.id)).state, job.state);
  }
  assert.deepEqual(jobs.map(job => ({ record: f.store.get(job.id), events: f.store.events(job.id) })), before);
  assert.deepEqual(f.commands.preservationRows(), legacy);
  assert.deepEqual(f.cleanups, jobs.map(job => job.id)); assert.equal(f.saves.length, 0); assert.equal(f.audits.length, 0);
});

test('live completion still persists and audits once and notifies, resolves and cleans up once', async t => {
  const f = await fixture(t); let queue, executions = 0;
  f.scheduler = createOperationScheduler({ store: f.store, execute: (record, options) => queue.executeScheduled(record.id, options),
    onChange: record => queue?.syncOperation(record) });
  queue = f.queue({ scheduler: f.scheduler, executeOperation: async () => { executions++; return outcome; } });
  const job = queue.submitOperation({ kind: 'command', command: 'fixture live command' });
  f.commands.insert(job, 'live-key', 'live-digest');
  queue.track(job.id, value => { f.saves.push(value); f.commands.save(value); });
  queue.start(job.id);
  const calls = observe(queue, job.id), completed = await queue.wait(job.id);
  assert.equal(completed.state, 'completed'); assert.equal(executions, 1);
  const record = f.store.get(job.id), events = f.store.events(job.id);
  assert.equal(record.metadata.approval.state, 'completed');
  assert.equal(f.commands.find('live-key').job.state, 'completed');
  assert.equal(f.saves.filter(value => value.state === 'completed').length, 1);
  assert.equal(f.audits.filter(event => event.action === 'completed').length, 1);
  assert.equal(events.filter(event => event.state === 'completed').length, 2, 'outcome plus persisted approval view');
  queue.syncOperation(record); assert.deepEqual(f.store.get(job.id), record); assert.deepEqual(f.store.events(job.id), events);
  assert.deepEqual(f.cleanups, [job.id]); assert.deepEqual(calls, { notified: 1, resolved: 1 });
});

test('startup terminal upload releases its artifact once while leaving its history and audit unchanged', async t => {
  const f = await fixture(t), artifactId = 'b'.repeat(48), job = f.seed('completed', 1, { kind: 'upload', artifactId });
  let files, pinned = true, releases = 0;
  const queue = f.queue({ onTerminal: value => { f.cleanups.push(value.id); files.onTerminal(value); } });
  // Real file cleanup use case; the artifact port records the released resource.
  files = createFileService({ queue, transfers: {}, now: () => 500, store: { releaseUpload(id, options) {
    assert.equal(id, artifactId); assert.deepEqual(options, { expiresAt: 500 }); pinned = false; releases++;
  } } });
  const before = f.store.get(job.id), events = f.store.events(job.id), legacy = f.commands.preservationRows();
  queue.restore(job, value => { f.saves.push(value); f.commands.save(value); }); const calls = observe(queue, job.id);
  queue.syncOperation(before, { restoring: true }); queue.syncOperation(before);
  assert.equal(pinned, false); assert.equal(releases, 1); assert.deepEqual(f.cleanups, [job.id]);
  assert.deepEqual(calls, { notified: 1, resolved: 1 }); assert.equal(f.saves.length, 0); assert.equal(f.audits.length, 0);
  assert.deepEqual(f.store.get(job.id), before); assert.deepEqual(f.store.events(job.id), events);
  assert.deepEqual(f.commands.preservationRows(), legacy); await files.close();
});
