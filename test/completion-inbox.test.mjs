import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, lstat, link, symlink, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
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
  // Reuse the existing process barrier/oracle; this inline branch adds no fixture runner.
  const waiterSource = `import { openCompletionInbox } from ${JSON.stringify(new URL('../src/adapters/cli/completion-inbox.mjs', import.meta.url).href)};
    let inbox, input;
    process.on('message', message => {
      try {
        if (message.type === 'prepare') {
          input = message.input; inbox = openCompletionInbox({filePath: input.filePath, now: () => input.now});
          process.send({type: 'ready'});
        } else if (message.type === 'go') {
          const value = inbox.acquireWaiter({bindingId: input.bindingId, ownerId: input.ownerId});
          process.send({type: 'result', value}, () => { inbox.close(); process.disconnect(); });
        }
      } catch (error) { process.send({type: 'error', code: error.code}, () => process.exit(1)); }
    });`;
  const child = input.action === 'waiter' ? spawn(process.execPath, ['--input-type=module', '--eval', waiterSource], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }) : fork(new URL('./fixtures/completion-inbox-worker.mjs', import.meta.url), [], {
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

// Native waiter cases were frozen before implementation in CLAUDE-NATIVE-WAITER-CASES.ko.md.
// This is the schema1 DDL from the pre-waiter contract, not a schema2 database downgraded for the test.
const schemaOne = `
  CREATE TABLE completion_bindings (
    binding_id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, UNIQUE(host, session_id)
  ) STRICT;
  CREATE TABLE completion_events (
    sequence INTEGER PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL REFERENCES completion_bindings(binding_id),
    origin TEXT NOT NULL, operation_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'claimed', 'acknowledged')),
    claim_token TEXT, lease_until INTEGER, attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    UNIQUE(binding_id, origin, operation_id, revision),
    CHECK((state = 'pending' AND claim_token IS NULL AND lease_until IS NULL AND attempt = 0) OR
      (state = 'claimed' AND claim_token IS NOT NULL AND lease_until IS NOT NULL AND attempt > 0) OR
      (state = 'acknowledged' AND claim_token IS NOT NULL AND lease_until IS NULL AND attempt > 0))
  ) STRICT;
  CREATE INDEX completion_claims ON completion_events(binding_id, state, lease_until, sequence);
  PRAGMA application_id = 1396919632; PRAGMA user_version = 1;
`;

async function legacyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-v1-'));
  const filePath = join(root, 'inbox.sqlite');
  await writeFile(filePath, '', { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(filePath);
  const bindingId = randomUUID(), receipts = [];
  try {
    db.exec(schemaOne);
    db.prepare('INSERT INTO completion_bindings VALUES (?, ?, ?)').run(bindingId, 'claude-code', sessionId);
    for (const [index, state] of ['pending', 'claimed', 'acknowledged'].entries()) {
      const event = completion(index + 1), receiptId = randomUUID();
      const claimToken = state === 'pending' ? null : randomUUID();
      db.prepare(`INSERT INTO completion_events(receipt_id, binding_id, origin, operation_id, revision, payload,
        state, claim_token, lease_until, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receiptId, bindingId, origin, event.id, event.targetRevision, JSON.stringify(event), state,
          claimToken, state === 'claimed' ? 30000 : null, state === 'pending' ? 0 : 1);
      receipts.push({ receiptId, state, claimToken });
    }
    return { filePath, bindingId, receipts, before: db.prepare('SELECT * FROM completion_events ORDER BY sequence').all() };
  } finally { db.close(); }
}

test('NW01 schema1 migration preserves exact event, claim, ACK and binding state and is repeatable', async t => {
  const f = await legacyFixture(t);
  for (let reopen = 0; reopen < 2; reopen++) {
    const inbox = openCompletionInbox({ filePath: f.filePath, now: () => 1000 });
    try {
      assert.equal(inbox.findBinding({ host: 'claude-code', sessionId }).bindingId, f.bindingId);
      assert.deepEqual(inbox.pending({ bindingId: f.bindingId }), { pending: 1, claimed: 1, acknowledged: 1 });
      assert.deepEqual(inbox.acknowledge({ bindingId: f.bindingId, ...f.receipts[2] }), { acknowledged: true, duplicate: true });
    } finally { inbox.close(); }
    const db = new DatabaseSync(f.filePath);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.deepEqual(db.prepare('SELECT * FROM completion_events ORDER BY sequence').all(), f.before);
      assert.equal(db.prepare('SELECT count(*) AS n FROM completion_waiters').get().n, 1);
    } finally { db.close(); }
  }
});

test('NW01 failed migration keeps schema1 rows and can migrate after the obstacle is removed', async t => {
  const f = await legacyFixture(t);
  let db = new DatabaseSync(f.filePath);
  try { db.exec('CREATE VIEW completion_waiters AS SELECT binding_id FROM completion_bindings'); }
  finally { db.close(); }
  assert.throws(() => openCompletionInbox({ filePath: f.filePath }), rejected);
  db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(db.prepare('SELECT * FROM completion_events ORDER BY sequence').all(), f.before);
    db.exec('DROP VIEW completion_waiters');
  } finally { db.close(); }
  const inbox = openCompletionInbox({ filePath: f.filePath });
  try { assert.deepEqual(inbox.pending({ bindingId: f.bindingId }), { pending: 1, claimed: 1, acknowledged: 1 }); }
  finally { inbox.close(); }
});

test('NW02 concurrent process acquisition has one winner per binding and independent sessions', async t => {
  const f = await fixture(t);
  const owners = Array.from({ length: 4 }, () => randomUUID());
  const workers = owners.map(ownerId => worker(t, { filePath: f.filePath, bindingId: f.binding.bindingId,
    now: 1000, action: 'waiter', ownerId }));
  await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.go());
  const results = await Promise.all(workers.map(w => w.result));
  await Promise.all(workers.map(w => w.exited));
  assert.equal(results.filter(result => result.acquired).length, 1);
  const winner = results.findIndex(result => result.acquired);
  const own = { bindingId: f.binding.bindingId, ownerId: owners[winner], generation: results[winner].generation };
  assert.deepEqual(f.inbox.pollWaiter(own), { active: true, messages: [] });
  const other = f.inbox.register({ host: 'claude-code', sessionId: otherSession });
  assert.equal(f.inbox.acquireWaiter({ bindingId: other.bindingId, ownerId: randomUUID() }).acquired, true);
});

test('NW03 expired owner cannot poll renew or release a replacement generation', async t => {
  const f = await fixture(t), ownerA = randomUUID(), ownerB = randomUUID();
  const a = f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: ownerA });
  const old = { bindingId: f.binding.bindingId, ownerId: ownerA, generation: a.generation };
  f.setNow(31000);
  const otherConnection = f.open();
  const b = otherConnection.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: ownerB });
  assert.equal(b.acquired, true); assert.ok(b.generation > a.generation);
  const receipt = enqueue(f.inbox, f.binding);
  assert.deepEqual(f.inbox.pollWaiter({ ...old, heartbeat: true }), { active: false, messages: [] });
  assert.deepEqual(f.inbox.releaseWaiter(old), { released: false });
  const next = otherConnection.pollWaiter({ bindingId: f.binding.bindingId, ownerId: ownerB, generation: b.generation });
  assert.equal(next.active, true); assert.equal(next.messages[0].receiptId, receipt.receiptId);
});

test('NW04 native poll and pendingOnly claims never redeliver expired claimed events', async t => {
  const f = await fixture(t), ownerId = randomUUID();
  enqueue(f.inbox, f.binding);
  const [original] = claim(f.inbox, f.binding, { leaseMs: 100 });
  f.setNow(1100);
  const receipt = enqueue(f.inbox, f.binding, completion(2));
  const acquired = f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId });
  const own = { bindingId: f.binding.bindingId, ownerId, generation: acquired.generation };
  const native = f.inbox.pollWaiter(own);
  assert.equal(native.messages.length, 1); assert.equal(native.messages[0].receiptId, receipt.receiptId);
  assert.deepEqual(claim(f.inbox, f.binding, { pendingOnly: true }), []);
  const [retry] = claim(f.inbox, f.binding);
  assert.equal(retry.receiptId, original.receiptId); assert.equal(retry.attempt, 2);
  assert.notEqual(retry.claimToken, original.claimToken);
});

test('NW07 SessionEnd invalidates ownership and rejects late arms until an actual SessionStart', async t => {
  const f = await fixture(t), ownerId = randomUUID();
  const acquired = f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId });
  const own = { bindingId: f.binding.bindingId, ownerId, generation: acquired.generation };
  const receipt = enqueue(f.inbox, f.binding);
  f.inbox.invalidateWaiter({ bindingId: f.binding.bindingId });
  assert.deepEqual(f.inbox.pollWaiter({ ...own, heartbeat: true }), { active: false, messages: [] });
  assert.equal(f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: randomUUID() }).acquired, false);
  assert.deepEqual(pending(f.inbox, f.binding), { pending: 1, claimed: 0, acknowledged: 0 });
  f.inbox.activateWaiter({ bindingId: f.binding.bindingId });
  const nextOwner = randomUUID(), next = f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: nextOwner });
  assert.equal(next.acquired, true); assert.ok(next.generation > acquired.generation);
  assert.equal(f.inbox.pollWaiter({ bindingId: f.binding.bindingId, ownerId: nextOwner, generation: next.generation }).messages[0].receiptId, receipt.receiptId);
});

test('NW09 heartbeat extends only an unexpired owner and stale lease recovery is bounded', async t => {
  const f = await fixture(t), ownerId = randomUUID();
  const acquired = f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId });
  const own = { bindingId: f.binding.bindingId, ownerId, generation: acquired.generation };
  f.setNow(11000); assert.deepEqual(f.inbox.pollWaiter({ ...own, heartbeat: true }), { active: true, messages: [] });
  f.setNow(31000); assert.equal(f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: randomUUID() }).acquired, false);
  f.setNow(41000); assert.deepEqual(f.inbox.pollWaiter({ ...own, heartbeat: true }), { active: false, messages: [] });
  assert.equal(f.inbox.acquireWaiter({ bindingId: f.binding.bindingId, ownerId: randomUUID() }).acquired, true);
});
