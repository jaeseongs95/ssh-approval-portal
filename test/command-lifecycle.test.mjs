import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalQueue, settledOutcome } from './support/approval-runtime.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { createLifecycleService } from '../src/application/lifecycle.mjs';
import { createAudit } from '../src/adapters/audit/jsonl.mjs';

const outcome = settledOutcome({ failed: false, texts: ['ok'] });
const classify = command => ({ class: command.startsWith('cat ') ? 'read-only' : 'privileged' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function commandFixture({ executeCommand = async () => outcome, executeOperation = async () => outcome, audit = () => {}, now } = {}) {
  const queue = new ApprovalQueue({ profile: 'writer', readProfile: 'reader', target: 'host', classify, audit, now,
    executeOperation: (operation, id, options) => operation.readOnly
      ? executeCommand('reader', operation.command, options) : executeOperation(operation, id, options) });
  const commands = createCommandService({ queue, classify });
  return { queue, commands };
}

test('AP-02 a failed read hides transport text and releases the shared scheduler slot for queued work', async () => {
  const events = [], gate = deferred(), started = deferred(), effects = [];
  const { queue, commands } = commandFixture({ audit: event => events.push(event), executeCommand: async (profile, command) => {
    assert.equal(profile, 'reader'); effects.push(command);
    if (command === 'cat /tmp/a') { started.resolve(); await gate.promise; throw Error('SECRET-TRANSPORT-CONTENT'); }
    return outcome;
  }, executeOperation: async operation => { effects.push(operation.command); return outcome; } });
  const read = commands.read('cat /tmp/a');
  const failedRead = assert.rejects(read, error => {
    assert.equal(error.code, 'READ_COMMAND_EXECUTION_UNKNOWN'); assert.equal(error.message.includes('SECRET'), false); return true;
  });
  await started.promise;
  assert.equal(commands.busy(), true); assert.equal(queue.busy(), true);
  const job = queue.submit('sudo id'); assert.equal(queue.start(job.id).state, 'queued');
  const nextRead = commands.read('cat /tmp/b');
  try { assert.deepEqual(effects, ['cat /tmp/a']); assert.equal(queue.scheduler.snapshot().queued, 2); }
  finally { gate.resolve(); }
  await failedRead;
  assert.equal((await queue.wait(job.id)).state, 'completed');
  assert.deepEqual(await nextRead, outcome);
  assert.equal(events.filter(event => event.action === 'unknown').length, 1);
  assert.equal(events.filter(event => event.action === 'completed').length, 2);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
  assert.equal(commands.busy(), false); assert.equal(queue.busy(), false);
  assert.deepEqual(effects, ['cat /tmp/a', 'sudo id', 'cat /tmp/b']);
});

test('read audit failures preserve fail-closed admission and durable outcomes after terminal audit errors', async () => {
  for (const failedAction of ['execution-queued', 'policy-execution-started', 'completed', 'unknown']) {
    let executions = 0; const events = [];
    const { commands, queue } = commandFixture({ audit: event => { events.push(event.action); if (event.action === failedAction) throw Error('audit unavailable'); },
      executeCommand: async () => { executions++; if (failedAction === 'unknown') throw Error('transport unavailable'); return outcome; } });
    if (['execution-queued', 'unknown'].includes(failedAction)) {
      await assert.rejects(commands.read('cat /tmp/a'), error => {
        assert.equal(error.code, failedAction === 'execution-queued' ? 'READ_COMMAND_NOT_STARTED' : 'READ_COMMAND_EXECUTION_UNKNOWN');
        assert.equal(error.message.includes('audit unavailable'), false); return true;
      });
    } else {
      const result = await commands.read('cat /tmp/a');
      if (failedAction === 'policy-execution-started') { assert.equal(result.failed, true); assert.equal(result.execution.remoteState, 'not_dispatched'); }
      else assert.deepEqual(result, outcome);
    }
    assert.equal(executions, ['execution-queued', 'policy-execution-started'].includes(failedAction) ? 0 : 1);
    assert.equal(commands.busy(), false);
    assert.equal(queue.scheduler.snapshot().active, 0);
    if (['completed', 'unknown'].includes(failedAction)) assert.match(queue.listAll()[0].auditError, /must not be retried/);
    assert.ok(events.includes(failedAction));
  }
});

test('command routing returns durable jobs for reads and owner approvals and shares the scheduler', async () => {
  const { queue, commands } = commandFixture();
  const read = await commands.run('cat /tmp/a');
  assert.equal(read.type, 'job'); assert.equal(read.job.profile, 'reader'); assert.equal(read.job.operation.readOnly, true);
  assert.deepEqual((await queue.wait(read.job.id)).result, outcome);
  const request = await commands.run('sudo id');
  assert.equal(request.type, 'job'); assert.equal(request.job.state, 'pending');
  assert.equal(request.job.profile, 'writer'); assert.equal(request.job.result, undefined);
  queue.start(request.job.id);
  const queuedRead = commands.read('cat /tmp/a');
  await queue.wait(request.job.id);
  assert.deepEqual(await queuedRead, outcome);
  queue.reserveMaintenance();
  await assert.rejects(commands.run('cat /tmp/a'), /Maintenance/);
  await assert.rejects(commands.run('sudo id'), /Maintenance/);
  const failedOutcome = settledOutcome({ failed: true, texts: ['Command returned a nonzero exit status'] }), events = [];
  const failed = commandFixture({ executeCommand: async () => failedOutcome, audit: event => events.push(event.action) });
  assert.deepEqual(await failed.commands.read('cat /tmp/missing'), failedOutcome);
  assert.deepEqual(events, ['submitted', 'execution-queued', 'policy-execution-started', 'failed']);
});

test('AP-01 expiry audit failure cannot resurrect a request and notifies terminal ownership once', () => {
  let now = 0, terminals = 0, executions = 0;
  const queue = new ApprovalQueue({ profile: 'writer', target: 'host', classify, now: () => now,
    audit: event => { if (event.action === 'expired') throw Error('audit unavailable'); },
    executeOperation: async () => { executions++; return outcome; }, onTerminal: () => terminals++ });
  const job = queue.submit('sudo id'); now = job.expiresAt;
  assert.equal(queue.listAll()[0].state, 'expired');
  assert.match(queue.get(job.id).auditError, /must not be retried/);
  assert.equal(queue.operationStore.get(job.id).state, 'expired');
  assert.equal(queue.get(job.id).state, 'expired');
  assert.throws(() => queue.start(job.id), /not pending/);
  assert.deepEqual(queue.list(), []); assert.equal(terminals, 1); assert.equal(executions, 0);
});

test('completion audit failure preserves the completed operation and prevents retry', async () => {
  let executions = 0;
  const queue = new ApprovalQueue({ profile: 'writer', target: 'host', classify,
    audit: event => { if (event.action === 'completed') throw Error('audit unavailable'); },
    executeOperation: async () => { executions++; return outcome; } });
  const job = queue.submit('sudo id');
  const result = await queue.approve(job.id);
  assert.equal(result.state, 'completed'); assert.match(result.auditError, /must not be retried/);
  assert.deepEqual(result.result, outcome); assert.equal(queue.busy(), false);
  await assert.rejects(queue.approve(job.id), /not pending/); assert.equal(executions, 1);
});

test('lifecycle blocks maintenance for commands, imports, staged data, and pending jobs', async () => {
  const { queue, commands } = commandFixture();
  let importing = false, staging = false;
  const files = { busy: () => importing, reap: async () => {}, close: async () => {} };
  const lifecycle = createLifecycleService({ queue, commands, files, store: { hasActiveWork: () => staging }, closeConnections: async () => {} });
  importing = true; assert.throws(() => lifecycle.reserve(), /Transfer or read/); importing = false;
  staging = true; assert.throws(() => lifecycle.reserve(), /Transfer or read/); staging = false;
  const pending = queue.submit('sudo id'); assert.throws(() => lifecycle.reserve(), /Requests must finish/);
  queue.deny(pending.id); lifecycle.reserve(); assert.equal(lifecycle.snapshot().maintenance, true);
  assert.throws(() => lifecycle.reserve(), /Requests must finish/);
  lifecycle.release(); assert.equal(lifecycle.snapshot().maintenance, false);
  const read = commands.read('cat /tmp/a'); assert.throws(() => lifecycle.reserve(), /Transfer or read/); await read;
  assert.deepEqual(lifecycle.snapshot(), { busy: false, pending: 0, maintenance: false });
});

test('lifecycle cleanup still reaps capabilities when expiry auditing or file reaping fails', async () => {
  const calls = [];
  const lifecycle = createLifecycleService({ queue: { reap() { calls.push('queue'); throw Error('audit unavailable'); } },
    files: { async reap() { calls.push('files'); } }, onReap: () => calls.push('capabilities') });
  await assert.rejects(lifecycle.reap(), /audit unavailable/);
  assert.deepEqual(calls, ['queue', 'files', 'capabilities']);
  calls.length = 0;
  const failedFiles = createLifecycleService({ queue: { reap() { calls.push('queue'); } },
    files: { async reap() { calls.push('files'); throw Error('storage unavailable'); } }, onReap: () => calls.push('capabilities') });
  await assert.rejects(failedFiles.reap(), /storage unavailable/);
  assert.deepEqual(calls, ['queue', 'files', 'capabilities']);
});

test('lifecycle close claims maintenance, drains file work and transports, then waits for execution before closing SSH', async () => {
  const calls = [], imports = deferred(), active = deferred(), transports = deferred();
  const queue = { maintenance: false, active: { completion: active.promise } };
  const lifecycle = createLifecycleService({ queue, files: { close() { calls.push('files'); return imports.promise; } },
    closeConnections: async () => { calls.push('connections'); } });
  const close = lifecycle.close(async () => { calls.push('transports'); await transports.promise; });
  assert.equal(queue.maintenance, true); assert.deepEqual(calls, ['files']);
  assert.equal(lifecycle.close(() => assert.fail('duplicate transport close')), close);
  imports.resolve(); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(calls, ['files', 'transports']);
  transports.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(calls.includes('connections'), false);
  active.resolve(); await close; assert.deepEqual(calls, ['files', 'transports', 'connections']);
});

test('JSONL audit persists an explicit metadata allowlist and uses injected redaction without result, ticket or payload bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-audit-'));
  try {
    const path = join(root, 'audit.jsonl'), options = [];
    const audit = createAudit({ path, now: () => new Date('2026-10-15T00:00:00Z'), redact: (text, config) => { options.push(config); return text.replace('SECRET', '[redacted]'); } });
    audit({ action: 'approved', id: 'fixture', profile: 'writer', command: 'echo SECRET', result: { data: 'PAYLOAD' }, ticket: 'TICKET' });
    audit({ action: 'submitted', operation: { kind: 'upload', remotePath: '/tmp/x', sha256: 'a'.repeat(64), size: 2, overwrite: false, elevate: true, bytes: 'PAYLOAD' } });
    const text = await readFile(path, 'utf8'), records = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2); assert.equal(records[0].at, '2026-10-15T00:00:00.000Z');
    assert.equal(records[0].command, 'echo [redacted]'); assert.match(records[0].commandHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(options, [{ entropyScan: true }]);
    for (const forbidden of ['SECRET', 'PAYLOAD', 'TICKET']) assert.equal(text.includes(forbidden), false);
    assert.equal(records[1].kind, 'upload'); assert.equal(records[1].elevate, true);
    assert.equal(Object.hasOwn(records[1], 'bytes'), false);
  } finally { await rm(root, { recursive: true }); }
});
