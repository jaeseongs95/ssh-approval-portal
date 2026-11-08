import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { openCompletionInbox } from '../src/adapters/cli/completion-inbox.mjs';
import { runCompletionHook, acknowledgeCompletion, waitForCompletionHook, completionWaitTimeoutMs } from '../src/adapters/cli/completion-hook.mjs';
import { runHook as main } from '../scripts/portal-files.mjs';

// TEST Node24 only. Pre-execution cases: HOOK-RENDER-CASES.ko.md in the workspace parent.
// Antigravity's renderer contract comes from root's AGS source comparison; real host receipt is NOT_RUN.
const sessionId = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const otherSession = '01a1a982-631e-7b70-8677-c32385867ac8';
const origin = 'https://portal.test';
const secret = 'PRIVATE_HOOK_FIXTURE_MARKER';
const completion = (n = 1, extra = {}) => ({ event: 'operation.finished', id: n.toString(16).padStart(48, '0'),
  state: 'completed', targetId: 'test', targetRevision: 'b'.repeat(64), finishedAt: 1234,
  failed: false, auditFailure: false, failureCode: null, exitCode: 0, reason: 'exit',
  remoteOutcome: 'completed', outputState: 'ready', ...extra });
const native = (event = 'PostToolUse', session = sessionId, extra = {}) => ({ hook_event_name: event, session_id: session, ...extra });
const safeError = error => error instanceof Error && !String(error.stack).includes(secret) && !JSON.stringify(error).includes(secret);
const contextOf = output => output.reason ?? output.hookSpecificOutput?.additionalContext ??
  output.injectSteps[0].systemMessage.systemMessage;
const recordsOf = output => JSON.parse(contextOf(output).slice(contextOf(output).indexOf('\n') + 1));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-hook-'));
  const inboxPath = join(root, 'inbox.sqlite');
  let now = 1000;
  const services = { openInbox: options => openCompletionInbox({ ...options, now: () => now }) };
  const db = operation => {
    const inbox = services.openInbox({ filePath: inboxPath });
    try { return operation(inbox); } finally { inbox.close(); }
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = (host = 'codex', session = sessionId, n = 1, extra = {}) => db(inbox => {
    const binding = inbox.register({ host, sessionId: session });
    return { binding, receipt: inbox.enqueue({ bindingId: binding.bindingId, origin, event: completion(n, extra) }) };
  });
  const run = (host = 'codex', input = native()) => runCompletionHook({ host, input, inboxPath }, services);
  const ack = fields => acknowledgeCompletion({ host: fields.host, sessionId: fields.session,
    receiptId: fields.receipt, claimToken: fields.claim, inboxPath }, services);
  const counts = binding => db(inbox => inbox.pending({ bindingId: binding.bindingId }));
  return { inboxPath, services, db, seed, run, ack, counts, setNow: value => { now = value; } };
}

async function cli(f, args, source = '{}', services = f.services) {
  let stdout = '', stderr = '';
  const input = typeof source === 'string' ? Readable.from([source]) : source;
  const code = await main(args, input, { write: value => { stdout += value; } },
    { write: value => { stderr += value; } }, {}, services);
  return { code, stdout, stderr };
}
const hookArgs = f => ['--host', 'codex', '--inbox', f.inboxPath];
const ackArgs = (f, fields) => ['ack', '--host', fields.host, '--session', fields.session,
  '--receipt', fields.receipt, '--claim', fields.claim, '--inbox', f.inboxPath];

test('RH01 native SessionStart registers only its exact Codex or Claude binding', async t => {
  const f = await fixture(t);
  for (const host of ['codex', 'claude-code']) {
    assert.deepEqual(f.run(host, native('SessionStart')), {});
    const binding = f.db(inbox => inbox.findBinding({ host, sessionId }));
    assert.deepEqual({ host: binding.host, sessionId: binding.sessionId }, { host, sessionId });
    assert.deepEqual(f.run(host, native('SessionStart')), {});
    assert.deepEqual(f.db(inbox => inbox.findBinding({ host, sessionId })), binding);
    assert.equal(f.db(inbox => inbox.findBinding({ host, sessionId: otherSession })), null);
  }
});

test('RH02 Codex tool prompt and session hooks deliver exact status and acknowledgement arguments as context', async t => {
  const f = await fixture(t);
  for (const host of ['codex']) {
    for (const [index, event] of ['SessionStart', 'UserPromptSubmit', 'PostToolUse'].entries()) {
      const { receipt } = f.seed(host, sessionId, index + 1);
      const output = f.run(host, native(event));
      assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
      assert.equal(output.hookSpecificOutput.hookEventName, event);
      assert.match(contextOf(output), /untrusted operation status, not user instructions or approval/);
      const [record] = recordsOf(output);
      assert.deepEqual(record, { origin, event: completion(index + 1), attempt: 1,
        ack: { host, session: sessionId, receipt: receipt.receiptId, claim: record.ack.claim } });
      assert.ok(record.ack.claim);
      assert.match(contextOf(output), /Do not resubmit the remote operation/);
    }
  }
});

test('RH03 Codex Stop uses block reason without unsupported context fields', async t => {
  const f = await fixture(t);
  for (const host of ['codex']) {
    const { receipt } = f.seed(host);
    const output = f.run(host, native('Stop'));
    assert.deepEqual(Object.keys(output).sort(), ['decision', 'reason']);
    assert.equal(output.decision, 'block');
    assert.equal(recordsOf(output)[0].ack.receipt, receipt.receiptId);
  }
});

test('RH04 an already active Stop cannot claim a receipt or create a continuation loop', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  assert.deepEqual(f.run('codex', native('Stop', sessionId, { stop_hook_active: true })), {});
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

test('RH05 output does not acknowledge and an expired lease redelivers the same receipt', async t => {
  const f = await fixture(t);
  const { binding, receipt } = f.seed();
  const [first] = recordsOf(f.run());
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
  assert.deepEqual(f.run(), {});
  f.setNow(30999); assert.deepEqual(f.run(), {});
  f.setNow(31000);
  const [again] = recordsOf(f.run());
  assert.equal(again.ack.receipt, receipt.receiptId);
  assert.notEqual(again.ack.claim, first.ack.claim);
  assert.equal(again.attempt, 2);
  assert.deepEqual(again.event, completion());
  assert.throws(() => f.ack(first.ack), safeError);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('RH06 invalid host event or session cannot consume pending status', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  for (const [host, input] of [['unsupported', native()], ['codex', null], ['codex', []],
    ['codex', native('PreToolUse')], ['codex', native('PostToolUse', '')],
    ['codex', native('PostToolUse', 'bad\nsession')], ['claude-code', { session_id: sessionId }]]) {
    assert.throws(() => f.run(host, input), safeError);
  }
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
  assert.equal(f.db(inbox => inbox.findBinding({ host: 'claude-code', sessionId })), null);
});

test('RH07 unresolved Codex or Claude child identity cannot take the parent session receipt or arm waiter', async t => {
  const f = await fixture(t);
  const { binding, receipt } = f.seed();
  assert.throws(() => f.run('codex', native('PostToolUse', sessionId, { agent_id: otherSession })), safeError);
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
  const output = f.run('codex', native('PostToolUse', sessionId, { agent_id: sessionId }));
  assert.equal(recordsOf(output)[0].ack.receipt, receipt.receiptId);
  const claudeSeed = f.seed('claude-code', sessionId, 2);
  assert.throws(() => f.run('claude-code', native('UserPromptSubmit', sessionId, { agent_id: otherSession })), safeError);
  await assert.rejects(() => waitForCompletionHook({ host: 'claude-code', input: native('PostToolUse', sessionId, { agent_id: otherSession }), inboxPath: f.inboxPath }, f.services), safeError);
  assert.deepEqual(f.counts(claudeSeed.binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

test('RH08 hook claims only the registered host and session combination', async t => {
  const f = await fixture(t);
  const own = f.seed(), other = f.seed('codex', otherSession, 2), host = f.seed('claude-code', sessionId, 3);
  const received = recordsOf(f.run());
  assert.equal(received.length, 1);
  assert.equal(received[0].ack.receipt, own.receipt.receiptId);
  assert.deepEqual(f.counts(other.binding), { pending: 1, claimed: 0, acknowledged: 0 });
  assert.deepEqual(f.counts(host.binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

test('RH09 acknowledgement requires exact binding and latest receipt token', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  f.seed('codex', otherSession, 2); f.seed('claude-code', sessionId, 3);
  const fields = recordsOf(f.run())[0].ack;
  assert.throws(() => f.ack({ ...fields, session: otherSession }), safeError);
  assert.throws(() => f.ack({ ...fields, host: 'claude-code' }), safeError);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
  assert.deepEqual(f.ack(fields), { acknowledged: true, duplicate: false });
  assert.deepEqual(f.ack(fields), { acknowledged: true, duplicate: true });
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 0, acknowledged: 1 });
});

test('RH10 native tool transcript fields and extra event secrets are never injected', async t => {
  const f = await fixture(t);
  f.seed('codex', sessionId, 1, { command: secret, output: secret, token: secret, privatePath: secret });
  const input = native('PostToolUse', sessionId, { transcript_path: secret, tool_input: { command: secret },
    tool_response: secret, last_assistant_message: secret });
  const before = structuredClone(input);
  const output = f.run('codex', input);
  assert.equal(JSON.stringify(output).includes(secret), false);
  assert.deepEqual(recordsOf(output)[0].event, completion());
  assert.deepEqual(input, before);
});

test('RH11 hook and failed acknowledgement close their real SQLite connection', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  let opened = 0, closed = 0;
  const services = { openInbox(options) {
    const inbox = f.services.openInbox(options); opened++;
    return { ...inbox, close() { closed++; inbox.close(); } };
  } };
  const output = runCompletionHook({ host: 'codex', input: native(), inboxPath: f.inboxPath }, services);
  assert.equal(opened, 1); assert.equal(closed, 1);
  const fields = recordsOf(output)[0].ack;
  assert.throws(() => acknowledgeCompletion({ host: fields.host, sessionId: otherSession,
    receiptId: fields.receipt, claimToken: fields.claim, inboxPath: f.inboxPath }, services), safeError);
  assert.equal(opened, 2); assert.equal(closed, 2);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('RC01 installed script entry point reads native stdin and writes a single JSON result', async t => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('../scripts/portal-files.mjs', import.meta.url));
  const { stdout } = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script, ...hookArgs(f)], { timeout: 10000, maxBuffer: 65536 },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(native('SessionStart')));
  });
  assert.equal(stdout, '{}\n');
  assert.equal(f.db(inbox => inbox.findBinding({ host: 'codex', sessionId })).sessionId, sessionId);
});

test('RC02 CLI hook renders claimed status without implicitly acknowledging it', async t => {
  const f = await fixture(t);
  const { binding, receipt } = f.seed();
  const result = await cli(f, hookArgs(f), JSON.stringify(native()));
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.equal(recordsOf(JSON.parse(result.stdout))[0].ack.receipt, receipt.receiptId);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('RC03 malformed JSON remains a safe nonblocking hook failure without input disclosure', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  const result = await cli(f, hookArgs(f), `{"broken":"${secret}`);
  assert.equal(result.code, 0); assert.equal(result.stdout, '{}\n');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'COMPLETION_HOOK_INVALID_JSON', automaticRetry: false });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

function sizedInput(bytes) {
  const base = native('SessionStart', otherSession, { tool_response: secret });
  const overhead = Buffer.byteLength(JSON.stringify(base));
  const source = JSON.stringify({ ...base, tool_response: secret + 'x'.repeat(bytes - overhead) });
  assert.equal(Buffer.byteLength(source), bytes);
  return Readable.from([source.slice(0, 32), source.slice(32)]);
}

test('RC04 exactly eight MiB of native input is accepted without echoing tool content', async t => {
  const f = await fixture(t);
  const result = await cli(f, hookArgs(f), sizedInput(8 * 1024 * 1024));
  assert.deepEqual(result, { code: 0, stdout: '{}\n', stderr: '' });
  assert.equal(f.db(inbox => inbox.findBinding({ host: 'codex', sessionId: otherSession })).sessionId, otherSession);
});

test('RC05 over eight MiB is bounded and leaves the target session unregistered', async t => {
  const f = await fixture(t);
  let opens = 0;
  const services = { openInbox(options) { opens++; return f.services.openInbox(options); } };
  const result = await cli(f, hookArgs(f), sizedInput(8 * 1024 * 1024 + 1), services);
  assert.equal(opens, 0);
  assert.equal(result.code, 0); assert.equal(result.stdout, '{}\n');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'COMPLETION_HOOK_INPUT_TOO_LARGE', automaticRetry: false });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.db(inbox => inbox.findBinding({ host: 'codex', sessionId: otherSession })), null);
});

test('RC06 explicit CLI acknowledgement uses exact fields and never consumes hook stdin', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  const fields = recordsOf(f.run())[0].ack;
  const unreadable = { [Symbol.asyncIterator]() { throw Error(secret); } };
  const first = await cli(f, ackArgs(f, fields), unreadable);
  assert.equal(first.code, 0); assert.equal(first.stderr, '');
  assert.deepEqual(JSON.parse(first.stdout), { acknowledged: true, duplicate: false });
  const again = await cli(f, ackArgs(f, fields), unreadable);
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(again.stdout), { acknowledged: true, duplicate: true });
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 0, acknowledged: 1 });
});

test('RC07 CLI acknowledgement errors cannot consume another host or session receipt', async t => {
  const f = await fixture(t);
  const { binding } = f.seed();
  const fields = recordsOf(f.run())[0].ack;
  for (const bad of [{ ...fields, session: otherSession }, { ...fields, host: 'claude-code' }]) {
    const result = await cli(f, ackArgs(f, bad));
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).automaticRetry, false);
  }
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('RC08 malformed CLI arguments keep hook and acknowledgement exit semantics separate', async t => {
  const f = await fixture(t);
  for (const args of [[...hookArgs(f), '--session', secret], ['--host', 'unsupported', '--inbox', f.inboxPath]]) {
    const result = await cli(f, args, JSON.stringify(native()));
    assert.equal(result.code, 0); assert.equal(result.stdout, '{}\n');
    assert.equal(JSON.parse(result.stderr).automaticRetry, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const result = await cli(f, ['ack', '--host', 'codex', '--session', secret]);
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('RC09 unexpected errors expose neither messages paths nor malformed error codes', async t => {
  const f = await fixture(t);
  const services = { openInbox() { throw Object.assign(Error(secret), { code: `${secret}\nPATH` }); } };
  const result = await cli(f, hookArgs(f), JSON.stringify(native()), services);
  assert.deepEqual(result, { code: 0, stdout: '{}\n',
    stderr: '{"error":"COMPLETION_HOOK_FAILED","automaticRetry":false}\n' });
});

test('AH01 agy session and invocation events use the source-defined nested system message', async t => {
  const f = await fixture(t);
  for (const [index, event] of ['SessionStart', 'PreInvocation', 'PostInvocation'].entries()) {
    const { receipt } = f.seed('antigravity', sessionId, index + 1);
    const output = f.run('antigravity', { hook_event_name: event, conversationId: sessionId });
    const context = contextOf(output);
    assert.equal(typeof context, 'string');
    assert.deepEqual(output, { injectSteps: [{ systemMessage: { systemMessage: context } }] });
    const [record] = recordsOf(output);
    assert.deepEqual(record.event, completion(index + 1));
    assert.deepEqual(record.ack, { host: 'antigravity', session: sessionId,
      receipt: receipt.receiptId, claim: record.ack.claim });
    assert.ok(record.ack.claim);
  }
});

test('AH02 a normal agy Stop continues with reason and keeps its claim unacknowledged', async t => {
  const f = await fixture(t);
  const { binding, receipt } = f.seed('antigravity');
  const output = f.run('antigravity', { hook_event_name: 'Stop', conversationId: sessionId, fullyIdle: true });
  assert.deepEqual(Object.keys(output).sort(), ['decision', 'reason']);
  assert.equal(output.decision, 'continue');
  assert.equal(recordsOf(output)[0].ack.receipt, receipt.receiptId);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('AH03 agy cancellation errors and exhausted limits cannot claim on Stop', async t => {
  const f = await fixture(t);
  const { binding } = f.seed('antigravity');
  const conditions = ['USER_CANCELED', 'ERROR', 'MAX_INVOCATIONS', 'MAX_FORCED_INVOCATIONS',
    'MAX_TOKEN_BUDGET_EXCEEDED', 'TERMINAL_STEP_TYPE', 'TERMINAL_CUSTOM_HOOK']
    .map(terminationReason => ({ terminationReason }));
  conditions.push({ error: secret }, { fullyIdle: false });
  for (const condition of conditions) {
    assert.deepEqual(f.run('antigravity', { hook_event_name: 'Stop', conversationId: sessionId,
      fullyIdle: true, ...condition }), {});
    assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
  }
});

test('AH04 agy accepts its native session field and rejects conflicting identities', async t => {
  const f = await fixture(t);
  for (const [index, identity] of [{ conversationId: sessionId }, { session_id: sessionId },
    { conversationId: sessionId, session_id: sessionId }].entries()) {
    const { receipt } = f.seed('antigravity', sessionId, index + 1);
    const output = f.run('antigravity', { hook_event_name: 'PreInvocation', ...identity });
    assert.equal(recordsOf(output)[0].ack.receipt, receipt.receiptId);
  }
  const { binding } = f.seed('antigravity', sessionId, 4);
  assert.throws(() => f.run('antigravity', { hook_event_name: 'PreInvocation', conversationId: sessionId,
    session_id: otherSession }), safeError);
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 3, acknowledged: 0 });
});

test('AH05 agy PostToolUse consumes only its own receipt at the native tool boundary', async t => {
  const f = await fixture(t);
  const { binding } = f.seed('antigravity');
  const output = f.run('antigravity', { hook_event_name: 'PostToolUse', conversationId: sessionId });
  assert.ok(contextOf(output));
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
});

test('AC01 only agy can supply a nonconflicting native event through the CLI flag', async t => {
  const f = await fixture(t);
  const { binding, receipt } = f.seed('antigravity');
  const args = ['--host', 'antigravity', '--event', 'PreInvocation', '--inbox', f.inboxPath];
  const accepted = await cli(f, args, JSON.stringify({ conversationId: sessionId }));
  assert.equal(accepted.code, 0); assert.equal(accepted.stderr, '');
  const output = JSON.parse(accepted.stdout);
  assert.deepEqual(output, { injectSteps: [{ systemMessage: { systemMessage: contextOf(output) } }] });
  assert.equal(recordsOf(output)[0].ack.receipt, receipt.receiptId);
  f.seed('antigravity', sessionId, 2);
  for (const [badArgs, source] of [[args, { conversationId: sessionId, hook_event_name: 'Stop' }],
    [[...hookArgs(f), '--event', 'PreInvocation'], native()]]) {
    const rejected = await cli(f, badArgs, JSON.stringify(source));
    assert.equal(rejected.code, 0); assert.equal(rejected.stdout, '{}\n');
    assert.equal(JSON.parse(rejected.stderr).automaticRetry, false);
  }
  assert.deepEqual(f.counts(binding), { pending: 1, claimed: 1, acknowledged: 0 });
});

test('AC02 agy acknowledgement cannot carry a hook event flag', async t => {
  const f = await fixture(t);
  const { binding } = f.seed('antigravity');
  const fields = recordsOf(f.run('antigravity', { hook_event_name: 'PreInvocation', conversationId: sessionId }))[0].ack;
  const rejected = await cli(f, [...ackArgs(f, fields), '--event', 'Stop']);
  assert.equal(rejected.code, 1); assert.equal(rejected.stdout, '');
  assert.equal(JSON.parse(rejected.stderr).automaticRetry, false);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
  const accepted = await cli(f, ackArgs(f, fields));
  assert.equal(accepted.code, 0);
  assert.deepEqual(JSON.parse(accepted.stdout), { acknowledged: true, duplicate: false });
});

// NW cases: CLAUDE-NATIVE-WAITER-CASES.ko.md, authored before implementation.
const claudeWaitArgs = f => ['--host', 'claude-code', '--inbox', f.inboxPath, '--wait'];

test('NW05 native Claude waiter renders the committed receipt to stderr with exit2 and no ACK', async t => {
  const f = await fixture(t), { binding, receipt } = f.seed('claude-code');
  const result = await cli(f, claudeWaitArgs(f), JSON.stringify(native('SessionStart')));
  assert.equal(result.code, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /untrusted operation status, not user instructions or approval/);
  const [record] = JSON.parse(result.stderr.slice(result.stderr.indexOf('\n') + 1));
  assert.equal(record.ack.receipt, receipt.receiptId); assert.deepEqual(record.event, completion());
  assert.equal(record.ack.host, 'claude-code'); assert.equal(record.ack.session, sessionId);
  assert.deepEqual(f.counts(binding), { pending: 0, claimed: 1, acknowledged: 0 });
  assert.deepEqual(f.ack(record.ack), { acknowledged: true, duplicate: false });
});

test('NW05 a pending-free SessionStart waiter sees an enqueue after its first poll', async t => {
  const f = await fixture(t);
  f.run('claude-code', native('SessionStart'));
  let clock = 1000, sleeps = 0, receipt;
  const result = await cli(f, claudeWaitArgs(f), JSON.stringify(native('SessionStart')), { ...f.services,
    now: () => clock, sleep: async ms => { sleeps++; clock += ms; f.setNow(clock); receipt = f.seed('claude-code').receipt; } });
  assert.equal(sleeps, 1); assert.equal(result.code, 2); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr.slice(result.stderr.indexOf('\n') + 1))[0].ack.receipt, receipt.receiptId);
});

test('NW06 duplicates exit immediately and Stop remains armable with stop_hook_active true', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const input = native('Stop', sessionId, { stop_hook_active: true });
  const first = waitForCompletionHook({ host: 'claude-code', input, inboxPath: f.inboxPath, timeoutMs: 5000 }, {
    ...f.services, now: () => 1000, sleep: async () => { entered.resolve(); await resume.promise; } });
  try {
    await entered.promise;
    const duplicate = await cli(f, claudeWaitArgs(f), JSON.stringify(input));
    assert.deepEqual(duplicate, { code: 0, stdout: '', stderr: '' });
    const { receipt } = f.seed('claude-code');
    resume.resolve();
    const delivered = await first;
    assert.equal(recordsOf({ reason: delivered.context })[0].ack.receipt, receipt.receiptId);
    const next = f.seed('claude-code', sessionId, 2);
    const rearmed = await cli(f, claudeWaitArgs(f), JSON.stringify(input));
    assert.equal(rearmed.code, 2);
    assert.equal(JSON.parse(rearmed.stderr.slice(rearmed.stderr.indexOf('\n') + 1))[0].ack.receipt, next.receipt.receiptId);
  } finally { resume.resolve(); await first; }
});

test('NW07 SessionEnd stops its worker, preserves pending status, and fences late Stop rearming', async t => {
  const f = await fixture(t), other = f.seed('claude-code', otherSession);
  let sleeps = 0, own;
  const ended = await waitForCompletionHook({ host: 'claude-code', input: native('PostToolUse'), inboxPath: f.inboxPath }, {
    ...f.services, now: () => 1000, sleep: async () => {
      sleeps++; f.run('claude-code', native('SessionEnd')); own = f.seed('claude-code', sessionId, 2);
    } });
  assert.equal(sleeps, 1); assert.deepEqual(ended, {});
  assert.deepEqual(f.counts(own.binding), { pending: 1, claimed: 0, acknowledged: 0 });
  assert.deepEqual(f.counts(other.binding), { pending: 1, claimed: 0, acknowledged: 0 });
  const late = await cli(f, claudeWaitArgs(f), JSON.stringify(native('Stop')));
  assert.deepEqual(late, { code: 0, stdout: '', stderr: '' });
  f.run('claude-code', native('SessionStart'));
  const resumed = await cli(f, claudeWaitArgs(f), JSON.stringify(native('Stop')));
  assert.equal(resumed.code, 2);
  assert.equal(JSON.parse(resumed.stderr.slice(resumed.stderr.indexOf('\n') + 1))[0].ack.receipt, own.receipt.receiptId);
  assert.deepEqual(f.counts(other.binding), { pending: 1, claimed: 0, acknowledged: 0 });
});

test('NW08 deadline and abort release the owned lease and close the SQLite connection', async t => {
  const f = await fixture(t);
  for (const mode of ['deadline', 'abort', 'signal']) {
    let clock = 1000, closed = 0, released = 0;
    const abort = new AbortController();
    const services = { ...f.services, now: () => clock,
      openInbox(options) { const inbox = f.services.openInbox(options); return { ...inbox,
        releaseWaiter(input) { released++; return inbox.releaseWaiter(input); }, close() { closed++; inbox.close(); } }; },
      sleep: async ms => {
        clock += ms; f.setNow(clock);
        if (mode === 'abort') { abort.abort(); throw Object.assign(Error('test abort'), { name: 'AbortError' }); }
        if (mode === 'signal') { process.emit('SIGTERM'); throw Object.assign(Error('test signal'), { name: 'AbortError' }); }
      },
    };
    if (mode === 'signal') {
      const before = process.listenerCount('SIGTERM');
      const result = await cli(f, claudeWaitArgs(f).concat('--wait-timeout-ms', '10'), JSON.stringify(native('Stop')), services);
      assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
      assert.equal(process.listenerCount('SIGTERM'), before);
    } else {
      const result = await waitForCompletionHook({ host: 'claude-code', input: native('Stop'), inboxPath: f.inboxPath,
        timeoutMs: 10, signal: abort.signal }, services);
      assert.deepEqual(result, {});
    }
    assert.equal(closed, 1); assert.equal(released, 1);
  }
});

test('NW09 polling is capped at one second and heartbeat renews every ten seconds until deadline', async t => {
  const f = await fixture(t);
  let clock = 1000, heartbeats = 0, sleeps = 0;
  const result = await waitForCompletionHook({ host: 'claude-code', input: native('Stop'), inboxPath: f.inboxPath, timeoutMs: 35000 }, {
    ...f.services, now: () => clock,
    openInbox(options) { const inbox = f.services.openInbox(options); return { ...inbox,
      pollWaiter(input) { if (input.heartbeat) heartbeats++; return inbox.pollWaiter(input); } }; },
    sleep: async ms => { assert.equal(ms, 1000); sleeps++; clock += ms; f.setNow(clock); },
  });
  assert.deepEqual(result, {}); assert.equal(sleeps, 35); assert.equal(heartbeats, 3);
});

test('NW10 Claude manifest uses exec argv, bounded asyncRewake, synchronous prompt drain and SessionEnd', async () => {
  const manifest = JSON.parse(await readFile(new URL('../hooks/claude-code.json', import.meta.url), 'utf8'));
  const handlers = event => manifest.hooks[event].flatMap(group => group.hooks);
  for (const event of ['SessionStart', 'Stop']) {
    const waits = handlers(event).filter(handler => handler.args.includes('--wait'));
    assert.equal(waits.length, 1); assert.equal(waits[0].async, true); assert.equal(waits[0].asyncRewake, true); assert.equal(waits[0].timeout, 86400);
    assert.ok(waits[0].timeout * 1000 > completionWaitTimeoutMs);
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd']) {
    assert.equal(handlers(event).filter(handler => !handler.args.includes('--wait')).length, 1);
  }
  for (const handler of Object.values(manifest.hooks).flatMap(groups => groups.flatMap(group => group.hooks))) {
    assert.equal(handler.command, 'node'); assert.equal(handler.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/portal-files.mjs');
    assert.equal(handler.args[1], '--host'); assert.equal(handler.args[2], 'claude-code');
    assert.equal(handler.async, handler.args.includes('--wait') ? true : undefined);
  }
});

test('NW12 invalid native wait flags fail before opening an inbox or claiming status', async t => {
  const f = await fixture(t), services = { openInbox: () => assert.fail('invalid wait must not open inbox') };
  const invalid = [hookArgs(f).concat('--wait'), claudeWaitArgs(f).concat('--wait-timeout-ms', '0'),
    claudeWaitArgs(f).concat('--wait-timeout-ms', '86400000'), claudeWaitArgs(f).concat('--wait-timeout-ms', '10\n'),
    ['--host', 'claude-code', '--wait-timeout-ms', '10'], claudeWaitArgs(f).concat('--event', 'Stop')];
  for (const args of invalid) {
    const result = await cli(f, args, JSON.stringify(native('Stop')), services);
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stderr).automaticRetry, false);
  }
  const unsupportedEvent = await cli(f, claudeWaitArgs(f), JSON.stringify(native('UserPromptSubmit')), services);
  assert.equal(JSON.parse(unsupportedEvent.stderr).error, 'COMPLETION_HOOK_INVALID_WAIT');
});

test('NW13 Claude short hooks never block Stop while UserPromptSubmit keeps lease redelivery', async t => {
  const f = await fixture(t), { binding, receipt } = f.seed('claude-code');
  for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
    assert.deepEqual(f.run('claude-code', native(event)), {});
    assert.deepEqual(f.counts(binding), { pending: 1, claimed: 0, acknowledged: 0 });
  }
  const [first] = recordsOf(f.run('claude-code', native('UserPromptSubmit')));
  assert.equal(first.ack.receipt, receipt.receiptId); assert.equal(first.ack.claim !== undefined, true);
  assert.deepEqual(acknowledgeCompletion({ receiptId: first.ack.receipt, claimToken: first.ack.claim, inboxPath: f.inboxPath }, f.services),
    { acknowledged: true, duplicate: false });
  const next = f.seed('claude-code', sessionId, 2);
  const [second] = recordsOf(f.run('claude-code', native('UserPromptSubmit')));
  assert.equal(second.ack.receipt, next.receipt.receiptId); assert.equal(second.attempt, 1);
  f.setNow(31000);
  const [again] = recordsOf(f.run('claude-code', native('UserPromptSubmit')));
  assert.equal(again.ack.receipt, next.receipt.receiptId); assert.equal(again.attempt, 2);
  assert.notEqual(again.ack.claim, second.ack.claim);
});

test('NW14 Claude active turn hooks pause an idle SessionStart waiter so Stop owns completion rewake', async t => {
  const f = await fixture(t);
  let sleeps = 0;
  const paused = await waitForCompletionHook({ host: 'claude-code', input: native('SessionStart'), inboxPath: f.inboxPath }, {
    ...f.services, now: () => 1000, sleep: async () => {
      sleeps++; f.run('claude-code', native('PostToolUse'));
    } });
  assert.equal(sleeps, 1); assert.deepEqual(paused, {});
  const { receipt } = f.seed('claude-code');
  const resumed = await cli(f, claudeWaitArgs(f), JSON.stringify(native('Stop')));
  assert.equal(resumed.code, 2);
  const [record] = JSON.parse(resumed.stderr.slice(resumed.stderr.indexOf('\n') + 1));
  assert.equal(record.ack.receipt, receipt.receiptId);
  const acked = await cli(f, ['ack', '--receipt', record.ack.receipt, '--claim', record.ack.claim, '--inbox', f.inboxPath]);
  assert.equal(acked.code, 0);
  assert.deepEqual(JSON.parse(acked.stdout), { acknowledged: true, duplicate: false });
});
