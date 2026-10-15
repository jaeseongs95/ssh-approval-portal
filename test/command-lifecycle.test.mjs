import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { createLifecycleService } from '../src/application/lifecycle.mjs';
import { createAudit } from '../src/adapters/audit/jsonl.mjs';

const outcome = { failed: false, texts: ['ok'] };
const classify = command => ({ class: command.startsWith('cat ') ? 'read-only' : 'privileged' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function commandFixture({ executeCommand = async () => outcome, audit = () => {}, now } = {}) {
  let commands;
  const queue = new ApprovalQueue({ profile: 'writer', target: 'host', classify, audit, now,
    executeOperation: async () => outcome, externalBusy: () => commands?.busy() ?? false });
  commands = createCommandService({ queue, classify, executeCommand, audit, target: 'host', readProfile: 'reader' });
  return { queue, commands };
}

test('AP-02 read rejection records failure, hides transport text, and releases the shared execution claim', async () => {
  const events = [], gate = deferred();
  const { queue, commands } = commandFixture({ audit: event => events.push(event), executeCommand: async profile => {
    assert.equal(profile, 'reader'); await gate.promise; throw Error('SECRET-TRANSPORT-CONTENT');
  } });
  const read = commands.read('cat /tmp/a');
  assert.equal(commands.busy(), true); assert.equal(queue.busy(), true);
  const job = queue.submit('sudo id'); assert.throws(() => queue.start(job.id), /already executing/);
  await assert.rejects(commands.read('cat /tmp/b'), /another operation/);
  gate.resolve();
  await assert.rejects(read, error => {
    assert.match(error.message, /Operation failed/); assert.equal(error.message.includes('SECRET'), false); return true;
  });
  assert.deepEqual(events.map(event => event.action), ['read-started', 'submitted', 'read-failed']);
  assert.equal(commands.busy(), false); assert.equal(queue.busy(), false);
  queue.start(job.id); assert.equal((await queue.wait(job.id)).state, 'completed');
});

test('read audit failures preserve fail-closed admission and release the claim after terminal audit errors', async () => {
  for (const failedAction of ['read-started', 'read-completed', 'read-failed']) {
    let executions = 0; const events = [];
    const { commands } = commandFixture({ audit: event => { events.push(event.action); if (event.action === failedAction) throw Error('audit unavailable'); },
      executeCommand: async () => { executions++; if (failedAction === 'read-failed') throw Error('transport unavailable'); return outcome; } });
    await assert.rejects(commands.read('cat /tmp/a'), /audit unavailable/);
    assert.equal(executions, failedAction === 'read-started' ? 0 : 1);
    assert.equal(commands.busy(), false);
    assert.equal(events.at(-1), failedAction);
  }
});

test('command routing keeps neutral outcomes separate from jobs and applies the shared operation lock', async () => {
  const { queue, commands } = commandFixture();
  assert.deepEqual(await commands.run('cat /tmp/a'), { type: 'immediate', outcome });
  const request = await commands.run('sudo id');
  assert.equal(request.type, 'job'); assert.equal(request.job.state, 'pending');
  assert.equal(request.job.profile, 'writer'); assert.equal(request.job.result, undefined);
  queue.start(request.job.id);
  await assert.rejects(commands.read('cat /tmp/a'), /another operation/);
  await queue.wait(request.job.id);
  queue.reserveMaintenance();
  await assert.rejects(commands.run('cat /tmp/a'), /Maintenance/);
  await assert.rejects(commands.run('sudo id'), /Maintenance/);
  const failedOutcome = { failed: true, texts: ['Command returned a nonzero exit status'] }, events = [];
  const failed = commandFixture({ executeCommand: async () => failedOutcome, audit: event => events.push(event.action) });
  assert.equal(await failed.commands.read('cat /tmp/missing'), failedOutcome);
  assert.deepEqual(events, ['read-started', 'read-failed']);
});

test('AP-01 expiry audit failure cannot resurrect a request and notifies terminal ownership once', () => {
  let now = 0, terminals = 0, executions = 0;
  const queue = new ApprovalQueue({ profile: 'writer', target: 'host', classify, now: () => now,
    audit: event => { if (event.action === 'expired') throw Error('audit unavailable'); },
    executeOperation: async () => { executions++; return outcome; }, onTerminal: () => terminals++ });
  const job = queue.submit('sudo id'); now = job.expiresAt;
  assert.throws(() => queue.listAll(), /audit unavailable/);
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
  assert.equal(result.result, outcome); assert.equal(queue.busy(), false);
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
