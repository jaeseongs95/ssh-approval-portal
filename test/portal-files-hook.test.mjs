import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/portal-files.mjs';
import { openCompletionInbox } from '../src/adapters/cli/completion-inbox.mjs';
import { defaultCompletionInboxPath, validateCompletionDeliveryTarget, deliverCompletion } from '../src/adapters/cli/completion-delivery.mjs';

// Requirement cases, written before execution. Execute on approved TEST only.
// Preconditions: Node24.2+, isolated private inbox, synthetic credentials/watcher/wake.
// H01: registered session -> watch terminal -> commit/close before wake -> same receipt/event, exit0.
// H02: absent exact binding -> invoke watch -> reject before credentials, close inbox, no registration.
// H03: invalid/mixed/non-watch options -> invoke CLI -> no inbox/auth/watch side effects, exit1.
// H04: wake unavailable/unknown/throw -> watch completes -> durable pending event, queued receipt, exit1.
// H05: failed/unknown terminal events -> watch -> unchanged failure semantics, receipt retained, exit1.
// H06: enqueue fails -> terminal watch -> close inbox, no wake/retry, completion retained, exit1.
// H07: watcher fails -> invoke watch -> preflight DB already closed, no enqueue/wake, exit1.
// H08: explicit duplicate delivery -> enqueue twice -> same receipt, one pending event, duplicate true.
// H09: default path -> resolve profile state base -> fixed private leaf, no session-derived path.
// H10: close fails after commit -> deliver -> queued receipt retained, wake unknown, no wake attempt.
// Pass criteria: all assertions for each case; actual results are recorded by the TEST runner.

const id = 'a'.repeat(48), origin = 'https://owner.example.test';
const sessionId = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const event = { event: 'operation.finished', id, state: 'completed', targetId: 'linux', targetRevision: 'b'.repeat(64),
  finishedAt: 1000, failed: false, auditFailure: false, failureCode: null, exitCode: 0, reason: 'exit',
  remoteOutcome: 'completed', outputState: 'ready' };
const capture = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };
const fail = code => Object.assign(Error('private error detail'), { code });

async function fixture(t, register = true) {
  const root = await mkdtemp(join(tmpdir(), 'portal-files-hook-'));
  const inboxPath = join(root, 'private', 'completion.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  let binding;
  const inbox = openCompletionInbox({ filePath: inboxPath });
  try { if (register) binding = inbox.register({ host: 'codex', sessionId }); }
  finally { inbox.close(); }
  return { inboxPath, binding,
    args: ['--origin', origin, '--cloudflared', process.execPath, 'watch', id,
      '--notify-hook', '--host', 'codex', '--session', sessionId, '--inbox', inboxPath],
    read(consume) { const selected = openCompletionInbox({ filePath: inboxPath }); try { return consume(selected); } finally { selected.close(); } } };
}

async function invoke(args, { result = event, credential, watcher, ...services } = {}) {
  const out = capture(), err = capture();
  const code = await main(args, out, err, credential ?? (() => 'synthetic.header.signature'), {},
    () => assert.fail('not an upload'), undefined,
    watcher ?? (() => ({ async connect() {}, async watch() { return result; }, async close() {} })),
    () => assert.fail('not a direct Codex notification'), services);
  return { code, out: out.text, err: err.text, value: out.text ? JSON.parse(out.text) : undefined };
}

test('H01 hook watch commits and closes before wake, without ACK or private extra fields', async t => {
  const f = await fixture(t); let closes = 0, wakes = 0, credentials = 0;
  const result = await invoke([...f.args, '--wake-executable', process.execPath], {
    result: { ...event, command: 'private command', output: 'private output' },
    openInbox(options) {
      const inbox = openCompletionInbox(options);
      return { findBinding: input => inbox.findBinding(input), enqueue: input => inbox.enqueue(input), close() { closes++; inbox.close(); } };
    },
    credential() { credentials++; assert.equal(closes, 1, 'preflight closes before credentials'); return 'synthetic.header.signature'; },
    async wake(input) {
      wakes++; assert.equal(closes, 2); assert.equal(input.host, 'codex'); assert.equal(input.sessionId, sessionId);
      assert.equal(input.executable, process.execPath); assert.equal(input.event, undefined);
      f.read(inbox => assert.deepEqual(inbox.pending({ bindingId: f.binding.bindingId }), { pending: 1, claimed: 0, acknowledged: 0 }));
      return { state: 'requested' };
    },
  });
  assert.equal(result.code, 0); assert.equal(credentials, 1); assert.equal(wakes, 1); assert.equal(closes, 2);
  assert.equal(result.value.state, 'completed'); assert.equal(result.value.notification.state, 'queued');
  const claimed = f.read(inbox => inbox.claim({ bindingId: f.binding.bindingId }));
  assert.equal(claimed[0].receiptId, result.value.notification.receiptId); assert.deepEqual(claimed[0].event, event);
});

test('H02 absent or other-session binding is rejected before credentials and never registered', async t => {
  const f = await fixture(t); let closed = 0;
  const argv = f.args.map(value => value === sessionId ? '01a15ca3-f838-7551-9620-7c3a8631c52d' : value);
  const result = await invoke(argv, {
    credential: () => assert.fail('no credentials'), wake: () => assert.fail('no wake'),
    openInbox(options) { const inbox = openCompletionInbox(options); return {
      findBinding: input => inbox.findBinding(input), close() { closed++; inbox.close(); },
    }; },
  });
  assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(closed, 1);
  assert.equal(JSON.parse(result.err).error, 'COMPLETION_BINDING_NOT_FOUND');
  f.read(inbox => assert.equal(inbox.findBinding({ host: 'codex', sessionId: argv[argv.indexOf('--session') + 1] }), null));
});

test('H03 incomplete, mixed, wrong-command, and relative-path options fail before side effects', async t => {
  const f = await fixture(t);
  const base = ['--origin', origin, 'watch', id];
  const invalid = [base.concat('--notify-hook'), base.concat('--host', 'codex'),
    base.concat('--session', sessionId), base.concat('--inbox', f.inboxPath), base.concat('--wake-executable', process.execPath),
    f.args.concat('--notify-codex', process.execPath, '--thread', sessionId), f.args.concat('--thread', sessionId),
    f.args.map(value => value === 'codex' ? 'unknown-host' : value),
    f.args.map(value => value === f.inboxPath ? 'relative.sqlite' : value), f.args.concat('--wake-executable', 'relative'),
    ['--origin', origin, 'doctor', '--notify-hook', '--host', 'codex', '--session', sessionId],
    ['--origin', origin, 'status', '12345678-1234-4234-8234-123456789abc', '--inbox', f.inboxPath]];
  for (const argv of invalid) {
    const result = await invoke(argv, { credential: () => assert.fail('no credentials'),
      openInbox: () => assert.fail('no inbox'), wake: () => assert.fail('no wake') });
    assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(JSON.parse(result.err).error, 'INVALID_COMPLETION_TARGET');
  }
});

test('H04 wake uncertainty keeps the committed receipt and SSH success, with exit1 and no retries', async t => {
  for (const state of ['unavailable', 'unknown', 'throw']) {
    const f = await fixture(t); let wakes = 0;
    const result = await invoke(f.args, { wake() { wakes++; if (state === 'throw') throw Error('private wake output');
      return { state, reasonCode: 'SYNTHETIC_WAKE_FAILURE' }; } });
    assert.equal(result.code, 1); assert.equal(wakes, 1); assert.equal(result.value.state, 'completed');
    assert.equal(result.value.notification.state, 'queued'); assert.equal(result.value.notification.automaticRetry, false);
    assert.equal(result.value.notification.wake.state, state === 'throw' ? 'unknown' : state);
    assert.doesNotMatch(result.err, /private wake output/);
    const claimed = f.read(inbox => inbox.claim({ bindingId: f.binding.bindingId }));
    assert.equal(claimed[0].receiptId, result.value.notification.receiptId); assert.deepEqual(claimed[0].event, event);
  }
});

test('H05 failed and uncertain terminal events retain their original semantics', async t => {
  for (const state of ['failed', 'denied', 'expired', 'cancelled', 'unknown']) {
    const f = await fixture(t); const terminal = { ...event, state, failed: true, remoteOutcome: 'unknown', exitCode: null };
    const result = await invoke(f.args, { result: terminal, wake: async () => ({ state: 'requested' }) });
    assert.equal(result.code, 1); assert.equal(result.value.state, state); assert.equal(result.value.failed, true);
    assert.deepEqual(f.read(inbox => inbox.claim({ bindingId: f.binding.bindingId }))[0].event, terminal);
  }
});

test('H06 failed enqueue closes the inbox and never wakes, while retaining terminal completion', async t => {
  const f = await fixture(t); let closed = 0, enqueues = 0;
  const result = await invoke(f.args, { openInbox: () => ({ findBinding: () => f.binding,
    enqueue() { enqueues++; throw fail('COMPLETION_INBOX_STORAGE_FAILED'); }, close() { closed++; } }),
  wake: () => assert.fail('must not wake before commit') });
  assert.equal(result.code, 1); assert.equal(closed, 2); assert.equal(enqueues, 1);
  assert.equal(result.value.state, 'completed'); assert.equal(result.value.notification.state, 'unknown');
  assert.match(result.err, /COMPLETION_INBOX_STORAGE_FAILED/); assert.doesNotMatch(result.err, /private error detail/);
});

test('H07 watcher failure happens with preflight inbox already closed and causes no delivery', async t => {
  const f = await fixture(t); let closed = 0, watcherClosed = 0;
  const result = await invoke(f.args, { openInbox: () => ({ findBinding: () => f.binding, close() { closed++; },
    enqueue: () => assert.fail('no event to enqueue') }), wake: () => assert.fail('no wake'),
  watcher: () => ({ async connect() { assert.equal(closed, 1); }, async watch() { throw fail('OWNER_REAUTH_REQUIRED'); },
    async close() { watcherClosed++; } }) });
  assert.equal(result.code, 1); assert.equal(result.out, ''); assert.equal(closed, 1); assert.equal(watcherClosed, 1);
  assert.equal(JSON.parse(result.err.trim().split('\n').at(-1)).error, 'OWNER_REAUTH_REQUIRED');
});

test('H08 duplicate explicit delivery retains one durable receipt and never ACKs it', async t => {
  const f = await fixture(t);
  const target = validateCompletionDeliveryTarget({ host: 'codex', sessionId, inboxPath: f.inboxPath });
  const services = { wake: async () => ({ state: 'requested' }) };
  const first = await deliverCompletion({ target, origin, event }, services);
  const second = await deliverCompletion({ target, origin, event }, services);
  assert.equal(first.receiptId, second.receiptId); assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  f.read(inbox => assert.deepEqual(inbox.pending({ bindingId: f.binding.bindingId }), { pending: 1, claimed: 0, acknowledged: 0 }));
});

test('H09 default inbox path comes only from the profile state base and fixed private leaf', () => {
  const base = tmpdir();
  const environment = { LOCALAPPDATA: base, XDG_STATE_HOME: base, HOME: base };
  assert.equal(defaultCompletionInboxPath(environment), join(base, 'ssh-mcp-completion', 'completion.sqlite'));
  if (process.platform !== 'win32') {
    assert.equal(defaultCompletionInboxPath({ HOME: base }), join(base, '.local', 'state', 'ssh-mcp-completion', 'completion.sqlite'));
  }
  assert.throws(() => defaultCompletionInboxPath({}), error => error.code === 'COMPLETION_INBOX_INVALID_PATH');
});

test('H10 cleanup failure after commit preserves the receipt and does not attempt wake', async () => {
  const receiptId = '12345678-1234-4234-8234-123456789abc';
  const result = await deliverCompletion({ target: { inboxPath: join(tmpdir(), 'unused.sqlite') }, origin, event }, {
    openInbox: () => ({ enqueue: () => ({ receiptId, state: 'pending', duplicate: false }), close() { throw Error('private close failure'); } }),
    wake: () => assert.fail('cleanup outcome is unknown'),
  });
  assert.equal(result.state, 'queued'); assert.equal(result.receiptId, receiptId);
  assert.deepEqual(result.wake, { state: 'unknown', reasonCode: 'COMPLETION_INBOX_CLEANUP_UNKNOWN' });
});
