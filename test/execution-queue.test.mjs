import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createOperationScheduler } from '../src/domain/operation-scheduler.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { dispatchRefusal } from '../src/domain/dispatch-failure.mjs';

const terminalOutcome = texts => ({ failed: false, texts, execution: { phase: 'settled', reason: 'exit', remoteState: 'exited', exitCode: 0, cleanupComplete: true, requiresReconciliation: false } });
const deferred = () => Promise.withResolvers();

// Actual durable store/scheduler; only the external executor is controlled.
// Run on CI/test servers. Local product execution is not authorized.
async function fixture(t, { concurrency = 1, capacity = 10, now = Date.now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'approval-scheduler-'));
  const store = createOperationStore(root), effects = [], controls = new Map(), terminals = [];
  let queue, active = 0, peak = 0;
  const scheduler = createOperationScheduler({ store, globalConcurrency: concurrency, targetConcurrency: concurrency,
    queueCapacity: capacity, targetQueueCapacity: capacity, now,
    execute: (record, options) => queue.executeScheduled(record.id, options), onChange: record => queue?.syncOperation(record) });
  queue = new ApprovalQueue({ classify: command => ({ class: command.startsWith('read') ? 'read-only' : 'privileged' }),
    profile: 'writer', target: 'target', identity: { targetId: 'target', targetRevision: 'a'.repeat(64) }, now,
    operationStore: store, scheduler, onTerminal: job => terminals.push(job.id),
    executeOperation: async (operation, id, options) => {
      const control = controls.get(operation.command);
      effects.push({ command: operation.command, id, signal: options.signal, readOnly: operation.readOnly });
      active++; peak = Math.max(peak, active); control.started.resolve();
      try { await control.done.promise; return terminalOutcome([operation.command]); }
      finally { active--; }
    } });
  const prepare = command => { const control = { started: deferred(), done: deferred() }; controls.set(command, control); return control; };
  const submit = (command, options) => { prepare(command); return queue.submitOperation({ kind: 'command', command }, 'privileged', options); };
  const automatic = command => { const job = submit(command); queue.setDecision(job.id, { decision: 'execute', reasonCode: 'test_server_bypass' }); return queue.startCommand(job.id); };
  t.after(async () => {
    queue.maintenance = true;
    for (const control of controls.values()) control.done.resolve();
    await queue.drain(); scheduler.close(); store.close(); await rm(root, { recursive: true, force: true });
  });
  return { queue, scheduler, store, submit, automatic, effects, terminals, prepare,
    commands: createCommandService({ queue, classify: queue.classify }),
    started: command => controls.get(command).started.promise, release: command => controls.get(command).done.resolve(), get peak() { return peak; } };
}

test('approval intent is durable before approval; approval queues into the single scheduler', async t => {
  const f = await fixture(t), pending = f.submit('pending');
  const intent = f.store.get(pending.id);
  assert.equal(intent.state, 'accepted'); assert.equal(intent.input.operation.command, 'pending');
  assert.equal(f.effects.length, 0);
  const queued = f.queue.start(pending.id);
  assert.equal(queued.state, 'queued'); assert.equal(f.store.get(pending.id).state, 'queued');
  assert.equal(f.store.get(pending.id).metadata.approval.approvalMode, 'owner');
  await f.started('pending'); assert.ok(f.effects[0].signal instanceof AbortSignal);
  f.release('pending'); assert.equal((await f.queue.wait(pending.id)).state, 'completed');
  assert.equal(f.store.get(pending.id).state, 'completed');
});

test('two approved jobs on the same target use two configured slots and remaining work is queued', async t => {
  const f = await fixture(t, { concurrency: 2 });
  const first = f.automatic('first'), second = f.automatic('second'), third = f.automatic('third');
  await Promise.all([f.started('first'), f.started('second')]);
  assert.equal(f.peak, 2); assert.equal(f.queue.get(third.id).state, 'queued');
  f.release('first'); await f.queue.wait(first.id); await f.started('third');
  f.release('second'); f.release('third'); await Promise.all([f.queue.wait(second.id), f.queue.wait(third.id)]);
  assert.equal(f.effects.length, 3); assert.equal(new Set(f.effects.map(item => item.id)).size, 3);
});

test('reads wait in the same durable queue and command run returns a job handle', async t => {
  const f = await fixture(t), first = f.automatic('first'); await f.started('first');
  f.prepare('read-one'); const read = f.commands.read('read-one');
  const readIntent = f.store.list().find(record => record.input.operation.command === 'read-one');
  assert.equal(readIntent.state, 'queued'); assert.equal(f.effects.length, 1);
  f.release('first'); await f.queue.wait(first.id); await f.started('read-one'); f.release('read-one');
  assert.deepEqual((await read).texts, ['read-one']);
  f.prepare('read-two'); const result = await f.commands.run('read-two');
  assert.equal(result.type, 'job'); assert.equal(result.job.operation.readOnly, true);
  await f.started('read-two'); f.release('read-two'); await f.queue.wait(result.job.id);
});

test('queued policy revalidation refuses revoked work without effects or blocking followers', async t => {
  const f = await fixture(t), first = f.automatic('first'); await f.started('first');
  const revoked = f.automatic('revoked'), next = f.automatic('next');
  f.queue.beforeCommandStart = job => { if (job.id === revoked.id) dispatchRefusal('policy_changed', 'policy_guard', 'Synthetic policy changed'); };
  f.release('first'); await f.queue.wait(first.id);
  const refused = await f.queue.wait(revoked.id);
  assert.equal(refused.state, 'failed'); assert.equal(refused.decision.dispatchFailureReason, 'policy_changed');
  assert.equal(f.store.get(revoked.id).result.execution.remoteState, 'not_dispatched');
  await f.started('next'); f.release('next'); await f.queue.wait(next.id);
  assert.deepEqual(f.effects.map(item => item.command), ['first', 'next']);
});

test('queued denial and expiry settle approval observers once and never dispatch', async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now }), first = f.automatic('first'); await f.started('first');
  const denied = f.automatic('denied'); assert.equal(f.queue.deny(denied.id).state, 'denied');
  assert.equal((await f.queue.wait(denied.id)).state, 'denied'); assert.equal(f.store.get(denied.id).state, 'denied');
  const expires = f.submit('expires', { expiresAt: 1020 }); f.queue.start(expires.id); now = 1020;
  assert.equal(f.queue.get(expires.id).state, 'expired'); assert.equal((await f.queue.wait(expires.id)).state, 'expired');
  f.release('first'); await f.queue.wait(first.id);
  assert.deepEqual(f.effects.map(item => item.command), ['first']);
  assert.equal(f.terminals.filter(id => id === denied.id).length, 1); assert.equal(f.terminals.filter(id => id === expires.id).length, 1);
});

test('uncertain execution is durable unknown and cannot be approved or replayed', async t => {
  const f = await fixture(t);
  f.queue.executeOperation = async () => { throw Error('private transport failure'); };
  const job = f.automatic('uncertain'), result = await f.queue.wait(job.id);
  assert.equal(result.state, 'unknown'); assert.equal(f.store.get(job.id).requiresReconciliation, true);
  assert.throws(() => f.queue.start(job.id)); assert.throws(() => f.queue.startCommand(job.id));
  assert.doesNotMatch(JSON.stringify(result), /private transport failure/);
});

test('external submission identity is preserved in the durable exact input contract', async t => {
  const f = await fixture(t);
  f.queue.submissionIdentity = () => ({ id: 'operation-id', requestKey: 'owner-request-key', owner: 'fixture-owner', inputDigest: 'digest' });
  const job = f.submit('identity'), record = f.store.get(job.id);
  assert.equal(job.id, 'operation-id'); assert.equal(job.operationKey, 'owner-request-key');
  assert.equal(record.requestKey, 'owner-request-key'); assert.equal(record.owner, 'fixture-owner'); assert.equal(record.inputDigest, 'digest');
  f.queue.deny(job.id);
});
