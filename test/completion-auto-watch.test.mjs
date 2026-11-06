import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoWatchCompletion } from '../src/adapters/cli/completion-auto-watch.mjs';
import { openCompletionInbox } from '../src/adapters/cli/completion-inbox.mjs';
import { runCompletionHook, acknowledgeCompletion } from '../src/adapters/cli/completion-hook.mjs';
import { main as portalFiles } from '../scripts/portal-files.mjs';

// Written before execution: ../auto-hook-20261106-r1/TEST-CASES.ko.md.
// Product execution is permitted only on TEST Node24. Fake spawn removes the host,
// remote HTTP, OS child lifetime and actual wake boundaries from this component test.
const sessionA = '01a15ca3-f838-7551-9620-7c3a8631c52c';
const sessionB = '01a1a982-631e-7b70-8677-c32385867ac8';
const id = 'a'.repeat(48), revision = 'b'.repeat(64), origin = 'https://owner.example.test';
const marker = 'PRIVATE_AUTO_WATCH_FIXTURE_MARKER';
const cli = fileURLToPath(new URL('../scripts/portal-files.mjs', import.meta.url));
const operation = extra => ({ id, state: 'queued', targetId: 'default', targetRevision: revision, ...extra });
const envelope = extra => ({ contractVersion: '2.0', ok: true, error: null, data: operation(), ...extra });
const native = (extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: sessionA,
  tool_name: 'mcp__ssh_test_submit', tool_input: {}, tool_response: { structuredContent: envelope() }, ...extra });
const safeError = error => error instanceof Error && !String(error.stack).includes(marker) &&
  !JSON.stringify(error).includes(marker);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'completion-auto-watch-'));
  const inboxPath = join(root, 'private', 'inbox.sqlite'), configPath = join(root, 'auto-watch.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { version: 1, cloudflared: process.execPath,
    routes: [{ origin, tools: ['mcp__ssh_test_submit', 'mcp__ssh_test_observe'] }] };
  await writeFile(configPath, JSON.stringify(config));
  let now = 1000;
  const openInbox = options => openCompletionInbox({ ...options, now: () => now });
  function db(consume) {
    const inbox = openInbox({ filePath: inboxPath });
    try { return consume(inbox); } finally { inbox.close(); }
  }
  db(inbox => {
    inbox.register({ host: 'codex', sessionId: sessionA });
    inbox.register({ host: 'codex', sessionId: sessionB });
    inbox.register({ host: 'claude-code', sessionId: sessionA });
    inbox.register({ host: 'antigravity', sessionId: sessionA });
  });
  const calls = [];
  let unrefs = 0;
  function spawn(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => { unrefs++; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }
  const run = (input = native(), extra = {}, services = {}) => autoWatchCompletion({
    host: 'codex', input, inboxPath, configPath, environment: {}, ...extra,
  }, { spawn, openInbox, ...services });
  return { root, configPath, inboxPath, config, calls, db, run, get unrefs() { return unrefs; },
    setNow(value) { now = value; },
    async configure(value) { await writeFile(configPath, JSON.stringify(value)); } };
}

const option = (args, flag) => args[args.indexOf(flag) + 1];

test('AW01 configured submit automatically starts the existing watch for the exact host session', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.state, 'started'); assert.equal(f.calls.length, 1);
  const { command, args } = f.calls[0];
  assert.equal(command, process.execPath); assert.equal(args[0], cli);
  assert.equal(option(args, '--origin'), origin);
  assert.equal(option(args, '--cloudflared'), process.execPath);
  assert.equal(args[args.indexOf('watch') + 1], id);
  assert.ok(args.includes('--notify-hook')); assert.equal(option(args, '--host'), 'codex');
  assert.equal(option(args, '--session'), sessionA); assert.equal(option(args, '--inbox'), f.inboxPath);
  assert.equal(f.unrefs, 1);
});

test('AW02 configured observe response starts a watch with its existing operation id', async t => {
  const f = await fixture(t);
  const result = await f.run(native({ tool_name: 'mcp__ssh_test_observe', tool_input: { id },
    tool_response: { structuredContent: envelope({ data: operation({ state: 'running' }) }) } }));
  assert.equal(result.state, 'started'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('watch') + 1], id);
  assert.equal(f.calls[0].args.includes('submit'), false);
});

test('AW03 unconfigured and near-match tool routes do not start a watcher', async t => {
  const f = await fixture(t);
  for (const tool_name of ['submit', 'mcp__other_submit', 'mcp__ssh_test_submit_extra',
    'xmcp__ssh_test_submit', 'mcp__ssh_test_submit\n', marker]) {
    assert.equal((await f.run(native({ tool_name }))).state, 'ignored', tool_name);
  }
  assert.equal(f.calls.length, 0);
});

test('AW04 only contract 2.0 success at the recognized response boundary can start a watcher', async t => {
  const f = await fixture(t);
  const invalid = [envelope({ ok: false }), envelope({ contractVersion: '1.0' }),
    envelope({ ok: undefined }), envelope({ error: { code: 'REJECTED' } }),
    { nested: envelope() }, { data: operation() }];
  for (const value of invalid) {
    assert.equal((await f.run(native({ tool_response: { structuredContent: value } }))).state, 'ignored');
  }
  assert.equal((await f.run(native({ tool_response: { isError: true, structuredContent: envelope() } }))).state, 'ignored');
  assert.equal(f.calls.length, 0);
});

test('AW05 malformed operation identity revision or target cannot be promoted into a watch', async t => {
  const f = await fixture(t);
  for (const change of [{ id: undefined }, { id: 'a'.repeat(47) }, { id: 'a'.repeat(49) },
    { id: id + '\n' }, { id: id.toUpperCase() }, { targetRevision: undefined },
    { targetRevision: 'b'.repeat(63) }, { targetRevision: revision + '\n' },
    { targetId: undefined }, { targetId: '../default' }, { targetId: 'a'.repeat(33) }, { targetId: 'default\n' }]) {
    const result = await f.run(native({ tool_response: { structuredContent: envelope({ data: operation(change) }) } }));
    assert.equal(result.state, 'ignored', JSON.stringify(change));
  }
  assert.equal(f.calls.length, 0);
});

test('AW06 private response bodies never become argv or public auto-watch output', async t => {
  const f = await fixture(t);
  const result = await f.run(native({ tool_input: { command: marker, credential: marker },
    tool_response: { structuredContent: envelope({ data: operation({ command: marker, output: marker,
      credential: marker, details: { origin: marker } }), debug: marker }), content: [{ type: 'text', text: marker }] } }));
  assert.equal(result.state, 'started'); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify({ result, calls: f.calls }).includes(marker), false);
});

test('AW07 duplicate hooks and observe calls share a durable single watch claim', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).state, 'started');
  for (const input of [native(), native({ tool_name: 'mcp__ssh_test_observe' }), native()]) {
    assert.equal((await f.run(input)).state, 'duplicate');
  }
  assert.equal(f.calls.length, 1); assert.equal(f.unrefs, 1);
});

test('AW07 the operation id stays canonical when an optional operation key disappears', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(native({ tool_response: { structuredContent: envelope({
    data: operation({ operationKey: 'stable-operation-key-1' }) }) } }))).state, 'started');
  assert.equal((await f.run(native({ tool_name: 'mcp__ssh_test_observe' }))).state, 'duplicate');
  assert.equal(f.calls.length, 1);
});

test('AW07 concurrent native hook invocations acquire only one durable watch claim', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.run()));
  assert.equal(results.filter(value => value.state === 'started').length, 1);
  assert.equal(results.filter(value => value.state === 'duplicate').length, 7);
  assert.equal(f.calls.length, 1);
});

test('AW08 exact session and host bindings have separate watcher claims', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).state, 'started');
  assert.equal((await f.run(native({ session_id: sessionB }))).state, 'started');
  assert.equal((await f.run(native(), { host: 'claude-code' })).state, 'started');
  assert.deepEqual(f.calls.map(call => [option(call.args, '--host'), option(call.args, '--session')]),
    [['codex', sessionA], ['codex', sessionB], ['claude-code', sessionA]]);
});

test('AW09 claims include the configured origin and do not merge separate owners', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).state, 'started');
  await f.configure({ ...f.config, routes: [{ ...f.config.routes[0], origin: 'https://second.example.test' }] });
  assert.equal((await f.run()).state, 'started');
  assert.deepEqual(f.calls.map(call => option(call.args, '--origin')), [origin, 'https://second.example.test']);
});

// Revision 2 distinguishes a read-only observer restart from replay of remote work.
// Superseded permanent-claim oracles are preserved beside TEST-CASES.ko.md.
test('AW10 a definite spawn failure releases its lease so the next hook can observe the same id', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const spawn = () => { attempts++; throw Object.assign(Error(marker), { code: 'ENOENT' }); };
  await assert.rejects(f.run(native(), {}, { spawn }), error => safeError(error) && error.code === 'COMPLETION_AUTO_WATCH_START_FAILED');
  assert.equal(attempts, 1);
  assert.equal((await f.run()).state, 'started');
  assert.equal((await f.run()).state, 'duplicate');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('watch') + 1], id);
  assert.equal(f.calls[0].args.includes('submit'), false);
});

test('AW10 a pre-spawn asynchronous error is sanitized and releases its observation lease', async t => {
  const f = await fixture(t);
  let attempts = 0;
  const spawn = () => { attempts++; const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', Object.assign(Error(marker), { code: 'EACCES' }))); return child; };
  await assert.rejects(f.run(native(), {}, { spawn }), error => safeError(error) && error.code === 'COMPLETION_AUTO_WATCH_START_FAILED');
  assert.equal(attempts, 1);
  assert.equal((await f.run()).state, 'started');
  assert.equal((await f.run()).state, 'duplicate');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('watch') + 1], id);
  assert.equal(f.calls[0].args.includes('submit'), false);
});

test('AW11 an unknown child is suppressed until lease expiry then only the same id is observed again', async t => {
  const f = await fixture(t);
  let attempts = 0, child;
  const spawn = () => { attempts++; child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child; };
  assert.equal((await f.run(native(), {}, { spawn })).state, 'started');
  child.emit('error', Object.assign(Error(marker), { code: 'EIO' }));
  child.emit('exit', 1, null);
  assert.equal((await f.run(native(), {}, { spawn })).state, 'duplicate');
  assert.equal(attempts, 1);
  f.setNow(600999);
  assert.equal((await f.run(native(), {}, { spawn })).state, 'duplicate'); assert.equal(attempts, 1);
  f.setNow(601000);
  assert.equal((await f.run()).state, 'started');
  assert.equal((await f.run()).state, 'duplicate');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('watch') + 1], id);
  assert.equal(f.calls[0].args.includes('submit'), false);
});

test('AW12 watcher launch uses detached shell-free hidden execution and private output fds', async t => {
  const f = await fixture(t);
  await f.run(native(), {}, { spawn(command, args, options) {
    assert.equal(command, process.execPath); assert.equal(args[0], cli);
    assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore');
    assert.equal(typeof options.stdio[1], 'number'); assert.equal(options.stdio[1], options.stdio[2]);
    assert.equal(fstatSync(options.stdio[1]).isFile(), true);
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  } });
});

test('AW13 response origin and executable fields cannot choose watcher routing or launch paths', async t => {
  const f = await fixture(t);
  const result = await f.run(native({ tool_response: { structuredContent: envelope({ origin: 'https://attacker.test',
    cloudflared: marker, executable: marker, route: marker, data: operation({ origin: 'https://attacker.test',
      cloudflared: marker, wakeExecutable: marker }) }) } }));
  assert.equal(result.state, 'started'); assert.equal(option(f.calls[0].args, '--origin'), origin);
  assert.equal(option(f.calls[0].args, '--cloudflared'), process.execPath);
  assert.equal(JSON.stringify({ result, calls: f.calls }).includes(marker), false);
});

test('AW14 invalid host inputs and missing configuration have no launch side effects', async t => {
  const f = await fixture(t);
  for (const input of [null, [], marker, {}, native({ hook_event_name: 'SessionStart' }),
    native({ session_id: '' }), native({ session_id: marker + '\n' }), native({ agent_id: sessionB })]) {
    try { assert.equal((await f.run(input)).state, 'ignored'); } catch (error) { assert.ok(safeError(error)); }
  }
  assert.equal((await f.run(native(), { configPath: undefined })).state, 'ignored');
  assert.equal(f.calls.length, 0);
});

test('AW14 invalid configuration never launches or exposes its original bytes', async t => {
  const f = await fixture(t);
  for (const config of [null, [], { ...f.config, version: 2 }, { ...f.config, routes: [] },
    { ...f.config, routes: [{ origin: 'http://attacker.test', tools: ['mcp__ssh_test_submit'] }] }]) {
    await f.configure(config);
    try { assert.equal((await f.run()).state, 'ignored'); } catch (error) { assert.ok(safeError(error)); }
  }
  await writeFile(f.configPath, marker);
  try { await f.run(); } catch (error) { assert.ok(safeError(error)); }
  assert.equal(f.calls.length, 0);
});

test('AW15 automatic watch arguments keep the existing inbox hook and explicit ACK binding', async t => {
  const f = await fixture(t);
  await f.run();
  const args = f.calls[0].args, host = option(args, '--host'), sessionId = option(args, '--session');
  const event = { event: 'operation.finished', id, state: 'completed', targetId: 'default', targetRevision: revision,
    finishedAt: 1000, failed: false, auditFailure: false, failureCode: null, exitCode: 0, reason: 'exit',
    remoteOutcome: 'completed', outputState: 'ready' };
  const binding = f.db(inbox => inbox.findBinding({ host, sessionId }));
  let stdout = '', stderr = '', watchCalls = 0;
  const exitCode = await portalFiles(args.slice(1), { write(value) { stdout += value; } },
    { write(value) { stderr += value; } }, () => 'synthetic.header.signature', {},
    () => assert.fail('automatic hook must not create an upload client'), undefined,
    () => ({ async connect() {}, async close() {}, async watch(selector) {
      watchCalls++; assert.equal(typeof selector === 'string' ? selector : selector.id, id); return event;
    } }), undefined, { wake: async () => ({ state: 'requested' }) });
  assert.equal(exitCode, 0, stderr); assert.equal(watchCalls, 1);
  const delivered = JSON.parse(stdout);
  assert.equal(delivered.notification.state, 'queued');
  const output = runCompletionHook({ host, input: native(), inboxPath: option(args, '--inbox') });
  const context = output.hookSpecificOutput.additionalContext;
  const [record] = JSON.parse(context.slice(context.indexOf('\n') + 1));
  assert.deepEqual(record.event, event); assert.equal(record.ack.receipt, delivered.notification.receiptId);
  assert.deepEqual(f.db(inbox => inbox.pending({ bindingId: binding.bindingId })), { pending: 0, claimed: 1, acknowledged: 0 });
  assert.deepEqual(acknowledgeCompletion({ host, sessionId, receiptId: record.ack.receipt,
    claimToken: record.ack.claim, inboxPath: f.inboxPath }), { acknowledged: true, duplicate: false });
  assert.deepEqual(f.db(inbox => inbox.pending({ bindingId: binding.bindingId })), { pending: 0, claimed: 0, acknowledged: 1 });
});

test('AW16 Antigravity native call wrapper watches its existing stable operation key', async t => {
  const f = await fixture(t);
  await f.configure({ ...f.config, routes: [{ origin, tools: ['mcp__ssh-test__submit'] }] });
  const input = { hook_event_name: 'PostToolUse', conversationId: sessionA,
    toolCall: { name: 'call_mcp_tool', args: { ServerName: 'ssh-test', ToolName: 'submit',
      Arguments: { operationKey: 'stable-operation-key-1', target: 'default', expectedTargetRevision: revision,
        command: marker, origin: 'https://attacker.test' } } } };
  assert.equal((await f.run(input, { host: 'antigravity' })).state, 'started');
  assert.equal((await f.run(input, { host: 'antigravity' })).state, 'duplicate');
  assert.equal(f.calls.length, 1);
  const args = f.calls[0].args;
  assert.equal(option(args, '--operation-key'), 'stable-operation-key-1');
  assert.equal(option(args, '--target'), 'default');
  assert.equal(option(args, '--expected-target-revision'), revision);
  assert.equal(option(args, '--host'), 'antigravity'); assert.equal(option(args, '--session'), sessionA);
  assert.equal(option(args, '--origin'), origin); assert.equal(JSON.stringify(f.calls).includes(marker), false);
});
