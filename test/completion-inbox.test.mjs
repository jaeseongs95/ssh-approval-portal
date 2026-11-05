import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, lstat, link, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCompletionInbox } from '../src/adapters/cli/completion-inbox.mjs';

// Execute only on approved TEST Node24. The pre-execution oracle is HOOK-CASES.ko.md.
const sessionId = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const otherSession = '01a1a982-631e-7b70-8677-c32385867ac8';
const origin = 'https://portal.test';
const privateMarker = 'PRIVATE_COMPLETION_INBOX_MARKER';
const completion = (n = 1, patch = {}) => ({ event: 'operation.finished', id: n.toString(16).padStart(48, '0'),
  state: 'completed', targetId: 'test', targetRevision: 'b'.repeat(64), finishedAt: 1234, failed: false,
  auditFailure: false, failureCode: null, exitCode: 0, reason: 'exit', remoteOutcome: 'completed', outputState: 'ready', ...patch });
const rejected = error => error instanceof Error && !String(error.stack).includes(privateMarker) &&
  !JSON.stringify(error).includes(privateMarker);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-inbox-'));
  const filePath = join(root, 'inbox.sqlite');
  let now = 1000;
  const connections = new Set();
  const open = () => {
    const inbox = openCompletionInbox({ filePath, now: () => now });
    connections.add(inbox);
    return inbox;
  };
  const close = inbox => { inbox.close(); connections.delete(inbox); };
  t.after(async () => {
    for (const inbox of connections) close(inbox);
    await rm(root, { recursive: true, force: true });
  });
  const inbox = open();
  const binding = inbox.register({ host: 'codex', sessionId });
  return { root, filePath, open, inbox, binding, close: () => close(inbox), setNow: value => { now = value; } };
}

function enqueue(inbox, binding, event = completion(), selectedOrigin = origin) {
  return inbox.enqueue({ bindingId: binding.bindingId, origin: selectedOrigin, event });
}
const claim = (inbox, binding, options = {}) => inbox.claim({ bindingId: binding.bindingId, ...options });
const pending = (inbox, binding) => inbox.pending({ bindingId: binding.bindingId });
const ack = (inbox, binding, message) => inbox.acknowledge({ bindingId: binding.bindingId,
  receiptId: message.receiptId, claimToken: message.claimToken });

// IPC readiness is the start gate; the timer is a failure deadline, never a scheduling sleep.
function worker(t, input) {
  const child = fork(new URL('./fixtures/completion-inbox-worker.mjs', import.meta.url), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  let resolveReady, resolveResult, resolveExit, rejectReady, rejectResult, rejectExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const fail = error => { rejectReady(error); rejectResult(error); rejectExit(error); };
  const deadline = setTimeout(() => { fail(Error('completion worker deadline exceeded')); child.kill(); }, 10000);
  child.once('error', fail);
  child.on('message', message => {
    if (message.type === 'ready') resolveReady();
    else if (message.type === 'result') resolveResult(message.value);
    else if (message.type === 'error') fail(Error(`worker API error: ${message.code}`));
  });
  child.once('exit', (code, signal) => {
    clearTimeout(deadline);
    const expected = input.crashAfterClaim ? 23 : 0;
    if (code !== expected || signal) fail(Error(`worker exit ${code}/${signal}: ${stderr}`));
    else { resolveExit({ code, signal }); rejectReady(Error('worker exited before ready')); rejectResult(Error('worker exited before result')); }
  });
  // Attach rejection handlers immediately, including before a readiness failure.
  void ready.catch(() => {}); void result.catch(() => {}); void exited.catch(() => {});
  t.after(() => { clearTimeout(deadline); if (child.exitCode === null) child.kill(); });
  child.send({ type: 'prepare', input });
  return { ready, result, exited, go: () => child.send({ type: 'go' }) };
}

test('I01 registration survives reopen and reuses only the exact binding', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.inbox.register({ host: 'codex', sessionId }), f.binding);
  assert.deepEqual(f.binding, { bindingId: f.binding.bindingId, host: 'codex', sessionId });
  assert.ok(f.binding.bindingId);
  f.close();
  const reopened = f.open();
  assert.deepEqual(reopened.findBinding({ host: 'codex', sessionId }), f.binding);
  assert.equal(reopened.findBinding({ host: 'codex', sessionId: otherSession }), null);
});

test('I02 committed enqueue survives response loss and duplicate watch after reopen', async t => {
  const f = await fixture(t);
  const first = enqueue(f.inbox, f.binding);
  assert.equal(first.duplicate, false);
  assert.ok(first.receiptId);
  f.close();
  const reopened = f.open();
  const again = enqueue(reopened, f.binding);
  assert.equal(again.receiptId, first.receiptId);
  assert.equal(again.duplicate, true);
  const received = claim(reopened, f.binding);
  assert.equal(received.length, 1);
  assert.equal(received[0].receiptId, first.receiptId);
  assert.deepEqual(received[0].event, completion());
});

test('I03 different payload at the same intent key conflicts without changing the original', async t => {
  const f = await fixture(t);
  const first = enqueue(f.inbox, f.binding);
  assert.throws(() => enqueue(f.inbox, f.binding, completion(1, { exitCode: 9 })), rejected);
  const received = claim(f.inbox, f.binding);
  assert.equal(received.length, 1);
  assert.equal(received[0].receiptId, first.receiptId);
  assert.deepEqual(received[0].event, completion());
});

test('I04 session host origin and revision keep their independent receipt boundaries', async t => {
  const f = await fixture(t);
  const other = f.inbox.register({ host: 'codex', sessionId: otherSession });
  const host = f.inbox.register({ host: 'claude', sessionId });
  assert.equal(new Set([f.binding.bindingId, other.bindingId, host.bindingId]).size, 3);
  const receipts = [enqueue(f.inbox, f.binding), enqueue(f.inbox, other), enqueue(f.inbox, host),
    enqueue(f.inbox, f.binding, completion(), 'https://second.test'),
    enqueue(f.inbox, f.binding, completion(1, { targetRevision: 'c'.repeat(64) }))];
  assert.equal(new Set(receipts.map(r => r.receiptId)).size, 5);
  const own = claim(f.inbox, f.binding);
  assert.deepEqual(new Set(own.map(r => r.receiptId)), new Set([receipts[0], receipts[3], receipts[4]].map(r => r.receiptId)));
  assert.equal(claim(f.inbox, other)[0].receiptId, receipts[1].receiptId);
  assert.equal(claim(f.inbox, host)[0].receiptId, receipts[2].receiptId);
});

test('I05 extra secrets are neither persisted returned nor included in idempotency', async t => {
  const f = await fixture(t);
  const event = { ...completion(), command: privateMarker, output: privateMarker, token: privateMarker, privatePath: privateMarker };
  const original = structuredClone(event);
  const first = enqueue(f.inbox, f.binding, event);
  const again = enqueue(f.inbox, f.binding, { ...event, token: 'different-extra-value' });
  assert.equal(again.receiptId, first.receiptId);
  assert.equal(again.duplicate, true);
  const received = claim(f.inbox, f.binding);
  assert.deepEqual(received[0].event, completion());
  assert.equal(JSON.stringify({ first, again, received }).includes(privateMarker), false);
  assert.deepEqual(event, original);
  f.close();
  for (const name of await readdir(f.root)) {
    assert.equal((await readFile(join(f.root, name))).includes(Buffer.from(privateMarker)), false, name);
  }
});

test('I06 invalid and credential-bearing origins are rejected before storage', async t => {
  const f = await fixture(t);
  for (const selected of ['http://portal.test', 'file:///tmp/test', `https://user:${privateMarker}@portal.test`,
    'https://portal.test?query=1', 'https://portal.test#fragment', 'not-an-origin']) {
    assert.throws(() => enqueue(f.inbox, f.binding, completion(), selected), rejected);
  }
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 0, claimed: 0, acknowledged: 0 });
});

test('I07 invalid terminal event fields leave no partial record and do not poison the connection', async t => {
  const f = await fixture(t);
  for (const patch of [{ event: 'instruction' }, { id: 'bad' }, { state: 'running' }, { targetId: 'bad target' },
    { targetRevision: 'bad' }, { finishedAt: -1 }, { failed: 'false' }, { auditFailure: null },
    { failureCode: 'bad code' }, { exitCode: 0.5 }, { reason: privateMarker },
    { remoteOutcome: privateMarker }, { outputState: privateMarker }, { exitCode: undefined }]) {
    assert.throws(() => enqueue(f.inbox, f.binding, completion(1, patch)), rejected);
    assert.deepEqual(pending(f.inbox, f.binding), { pending: 0, claimed: 0, acknowledged: 0 });
  }
  enqueue(f.inbox, f.binding);
  assert.deepEqual(claim(f.inbox, f.binding)[0].event, completion());
});

test('I08 bounded claim leaves the remainder and never repeats an unexpired receipt', async t => {
  const f = await fixture(t);
  for (let n = 1; n <= 3; n++) enqueue(f.inbox, f.binding, completion(n));
  const first = claim(f.inbox, f.binding, { limit: 2 });
  const second = claim(f.inbox, f.binding);
  assert.equal(first.length, 2); assert.equal(second.length, 1);
  assert.equal(new Set([...first, ...second].map(r => r.receiptId)).size, 3);
  for (const row of [...first, ...second]) { assert.ok(row.claimToken); assert.equal(row.attempt, 1); }
  assert.deepEqual(claim(f.inbox, f.binding), []);
});

test('I09 concurrent independent hook processes atomically claim each receipt once', async t => {
  const f = await fixture(t);
  const expected = [];
  for (let n = 1; n <= 12; n++) expected.push(enqueue(f.inbox, f.binding, completion(n)).receiptId);
  const workers = Array.from({ length: 4 }, () => worker(t, { filePath: f.filePath,
    bindingId: f.binding.bindingId, now: 1000, action: 'claim', limit: 4 }));
  await Promise.all(workers.map(w => w.ready));
  workers.forEach(w => w.go());
  const received = (await Promise.all(workers.map(w => w.result))).flat();
  await Promise.all(workers.map(w => w.exited));
  assert.equal(received.length, 12);
  assert.deepEqual(new Set(received.map(r => r.receiptId)), new Set(expected));
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 0, claimed: 12, acknowledged: 0 });
});

test('I10 unacknowledged claim survives process crash and is reclaimed at the lease boundary', async t => {
  const f = await fixture(t);
  const receipt = enqueue(f.inbox, f.binding);
  const w = worker(t, { filePath: f.filePath, bindingId: f.binding.bindingId,
    now: 1000, action: 'claim', leaseMs: 100, crashAfterClaim: true });
  await w.ready; w.go();
  const [first] = await w.result;
  assert.equal((await w.exited).code, 23);
  f.setNow(1099); assert.deepEqual(claim(f.inbox, f.binding), []);
  f.setNow(1100);
  const received = claim(f.inbox, f.binding);
  assert.equal(received.length, 1);
  assert.equal(received[0].receiptId, receipt.receiptId);
  assert.notEqual(received[0].claimToken, first.claimToken);
  assert.equal(received[0].attempt, 2);
  assert.deepEqual(received[0].event, completion());
});

test('I11 reassigned ownership fences stale tokens and other session acknowledgements', async t => {
  const f = await fixture(t);
  const other = f.inbox.register({ host: 'codex', sessionId: otherSession });
  enqueue(f.inbox, f.binding);
  const [old] = claim(f.inbox, f.binding, { leaseMs: 100 });
  f.setNow(1100);
  const [current] = claim(f.inbox, f.binding);
  assert.throws(() => ack(f.inbox, f.binding, old), rejected);
  assert.throws(() => ack(f.inbox, other, current), rejected);
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 0, claimed: 1, acknowledged: 0 });
  assert.deepEqual(ack(f.inbox, f.binding, current), { acknowledged: true, duplicate: false });
});

test('I12 the latest acknowledgement is durable and idempotent for that token only', async t => {
  const f = await fixture(t);
  enqueue(f.inbox, f.binding);
  const [received] = claim(f.inbox, f.binding);
  assert.deepEqual(ack(f.inbox, f.binding, received), { acknowledged: true, duplicate: false });
  f.close();
  const reopened = f.open();
  assert.deepEqual(ack(reopened, f.binding, received), { acknowledged: true, duplicate: true });
  assert.throws(() => ack(reopened, f.binding, { ...received, claimToken: randomUUID() }), rejected);
  assert.deepEqual(claim(reopened, f.binding), []);
  assert.deepEqual(pending(reopened, f.binding), { pending: 0, claimed: 0, acknowledged: 1 });
});

test('I13 pending claimed and acknowledged counts preserve separate evidence states', async t => {
  const f = await fixture(t);
  enqueue(f.inbox, f.binding); enqueue(f.inbox, f.binding, completion(2));
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 2, claimed: 0, acknowledged: 0 });
  const [received] = claim(f.inbox, f.binding, { limit: 1, leaseMs: 100 });
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 1, claimed: 1, acknowledged: 0 });
  ack(f.inbox, f.binding, received);
  f.setNow(1100);
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 1, claimed: 0, acknowledged: 1 });
});

test('I14 operations on a closed connection fail and a fresh connection remains usable', async t => {
  const f = await fixture(t);
  const receipt = enqueue(f.inbox, f.binding);
  f.close();
  for (const operation of [() => f.inbox.register({ host: 'codex', sessionId }),
    () => f.inbox.findBinding({ host: 'codex', sessionId }), () => enqueue(f.inbox, f.binding),
    () => claim(f.inbox, f.binding), () => pending(f.inbox, f.binding),
    () => ack(f.inbox, f.binding, { receiptId: receipt.receiptId, claimToken: randomUUID() })]) {
    assert.throws(operation, rejected);
  }
  assert.equal(claim(f.open(), f.binding)[0].receiptId, receipt.receiptId);
});

test('I15 unknown binding cannot insert claim or acknowledge another session receipt', async t => {
  const f = await fixture(t);
  const unknown = { bindingId: randomUUID() };
  enqueue(f.inbox, f.binding);
  assert.throws(() => enqueue(f.inbox, unknown), rejected);
  assert.throws(() => claim(f.inbox, unknown), rejected);
  const [received] = claim(f.inbox, f.binding);
  assert.throws(() => ack(f.inbox, unknown, received), rejected);
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('I16 private SQLite leaf works under the normal OS tmp ancestor including Windows', async t => {
  const f = await fixture(t);
  enqueue(f.inbox, f.binding);
  f.close();
  const directory = await lstat(f.root), file = await lstat(f.filePath);
  assert.equal(directory.isDirectory(), true);
  assert.equal(file.isFile(), true);
  assert.equal(file.isSymbolicLink(), false);
  assert.equal(file.nlink, 1);
  if (process.platform !== 'win32') {
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(file.mode & 0o777, 0o600);
    if (typeof process.getuid === 'function') assert.equal(file.uid, process.getuid());
  }
  assert.deepEqual(claim(f.open(), f.binding)[0].event, completion());
});

test('I17 unsafe POSIX file types and multiple links are rejected without altering the source', async t => {
  const f = await fixture(t);
  enqueue(f.inbox, f.binding);
  f.close();
  // Windows support is exercised by the normal API cases; ACL/symlink privileges are host checks.
  if (process.platform === 'win32') {
    assert.deepEqual(claim(f.open(), f.binding)[0].event, completion());
    return;
  }
  const alias = join(f.root, 'alias.sqlite');
  await symlink(f.filePath, alias);
  assert.throws(() => openCompletionInbox({ filePath: alias }), rejected);
  await rm(alias);
  await link(f.filePath, alias);
  assert.throws(() => openCompletionInbox({ filePath: f.filePath }), rejected);
  assert.throws(() => openCompletionInbox({ filePath: alias }), rejected);
  await rm(alias);
  const directory = join(f.root, 'directory.sqlite');
  await mkdir(directory, { mode: 0o700 });
  assert.throws(() => openCompletionInbox({ filePath: directory }), rejected);
  assert.deepEqual(claim(f.open(), f.binding)[0].event, completion());
});

test('I18 concurrent duplicate watches commit exactly one receipt', async t => {
  const f = await fixture(t);
  const workers = Array.from({ length: 4 }, () => worker(t, { filePath: f.filePath,
    bindingId: f.binding.bindingId, now: 1000, action: 'enqueue', origin, event: completion() }));
  await Promise.all(workers.map(w => w.ready));
  workers.forEach(w => w.go());
  const receipts = await Promise.all(workers.map(w => w.result));
  await Promise.all(workers.map(w => w.exited));
  assert.equal(new Set(receipts.map(r => r.receiptId)).size, 1);
  assert.equal(receipts.filter(r => r.duplicate === false).length, 1);
  assert.equal(receipts.filter(r => r.duplicate === true).length, 3);
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

test('I19 all terminal states preserve failure and unknown metadata without reinterpretation', async t => {
  const f = await fixture(t);
  const events = [completion(), completion(2, { state: 'failed', failed: true, failureCode: 'SSH_FAILED', exitCode: 9 }),
    ...['unknown', 'cancelled', 'denied', 'expired'].map((state, i) => completion(i + 3, {
      state, finishedAt: null, failed: null, exitCode: null, reason: null, remoteOutcome: 'unknown', outputState: null }))];
  const expected = new Map(events.map(event => [enqueue(f.inbox, f.binding, event).receiptId, event]));
  const received = claim(f.inbox, f.binding);
  assert.equal(received.length, events.length);
  for (const row of received) assert.deepEqual(row.event, expected.get(row.receiptId));
});
