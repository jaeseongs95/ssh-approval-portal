import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { openSshDesktopProcess } from '../src/adapters/ssh/vendor.mjs';
import { executionFailureDetails } from '../src/domain/execution-failure.mjs';
import { dispatchFailureDetails } from '../src/domain/dispatch-failure.mjs';

const command = "python3 -I -B -S -X utf8 -c 'fixed fixture helper'";
const tick = () => new Promise(resolve => setImmediate(resolve));

// Replace only the SSH wire. Real registry binding, dispatch checks, connection
// lifecycle and Node binary Duplex behavior remain under test.
function fixture({ deferred = false, profile: overrides = {}, connect } = {}) {
  const client = new EventEmitter(), writes = [], signals = [], calls = [];
  client.on('error', () => {});
  let acquisitions = 0, callback, ends = 0, clientEnds = 0;
  const profile = { readOnly: false, tty: false, ...overrides };
  let configured = profile;
  const stream = new Duplex({ read() {}, write(value, _encoding, done) { writes.push(Buffer.from(value)); done(); },
    final(done) { ends++; done(); } });
  stream.stderr = new PassThrough();
  Object.assign(stream, { type: 'session', server: false, _client: client, outgoing: { state: 'open', id: 7 } });
  client._protocol = { signal: (id, name) => { assert.equal(id, 7); signals.push(name); } };
  client.end = () => { clientEnds++; };
  client.destroy = () => { clientEnds++; };
  client.exec = (value, options, done) => { calls.push({ command: value, options }); callback = done; if (!deferred) done(null, stream); };
  const connection = { profile, ensureConnected: connect ?? (async () => {}), isConnected: () => true,
    getClient: () => client, channelEnv: () => ({ env: { LANG: 'C.UTF-8' }, pty: true }),
    applyWorkdir: () => assert.fail('A desktop helper must not inherit shell workdir rewriting') };
  const registry = { getProfile: () => configured, getOrCreate: async () => { acquisitions++; return connection; } };
  return { registry, client, stream, writes, signals, calls, profile, connection,
    get acquisitions() { return acquisitions; }, get ends() { return ends; }, get clientEnds() { return clientEnds; },
    release(error) { callback(error, error ? undefined : stream); },
    changeProfile() { configured = { ...profile, host: 'different.example' }; },
    finish(code = 0, signal) { stream.emit('exit', code, signal); stream.emit('close', code, signal); },
    open(options = {}) { return openSshDesktopProcess(registry, 'managed-linux', { command, ...options }); } };
}

test('fixed helper uses binary exec without PTY, keeps stderr separate and shares the client', async () => {
  const f = fixture(), guarded = [];
  const lease = await f.open({ beforeDispatch: async () => guarded.push('guard') });
  assert.deepEqual(f.calls, [{ command, options: { env: { LANG: 'C.UTF-8' }, pty: false } }]);
  assert.equal(guarded.length, 1);
  const binary = Buffer.from([0, 255, 128, 10, 13, 0]), received = [], metadata = [];
  lease.stream.on('data', bytes => received.push(bytes));
  lease.stream.stderr.on('data', bytes => metadata.push(bytes));
  lease.stream.write(binary);
  f.stream.push(binary.subarray(0, 2)); f.stream.push(binary.subarray(2));
  f.stream.stderr.write(Buffer.from('{"marker":"fixture","state":"ready"}\n'));
  await tick();
  assert.deepEqual(Buffer.concat(received), binary);
  assert.deepEqual(Buffer.concat(f.writes), binary);
  assert.equal(Buffer.concat(metadata).toString(), '{"marker":"fixture","state":"ready"}\n');
  assert.match(lease.diagnostics().text, /ready/);
  f.finish();
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'exit'); assert.equal(result.exitCode, 0);
  assert.equal(result.remoteState, 'exited'); assert.equal(result.cleanupComplete, true); assert.equal(result.error, undefined);
  assert.equal(f.clientEnds, 0); assert.equal(f.client.listenerCount('close'), 1); // shared lifecycle observer only
});

test('close is idempotent, sends TERM and EOF, and waits for observed exit/close', async () => {
  const f = fixture(), lease = await f.open();
  const first = lease.close(), second = lease.close();
  assert.equal(first, second); assert.equal(first, lease.exitPromise);
  assert.deepEqual(f.signals, ['TERM']); assert.equal(f.ends, 1);
  let resolved = false; first.then(() => { resolved = true; }); await tick(); assert.equal(resolved, false);
  f.finish(0);
  const result = await first;
  assert.equal(result.reason, 'close'); assert.equal(result.remoteState, 'exited'); assert.equal(result.cleanupComplete, true);
  assert.equal(f.clientEnds, 0); assert.equal(await lease.close(), result);
});

test('stderr metadata emitted before the caller awaits open is buffered separately', async () => {
  const f = fixture({ deferred: true }), opening = f.open(); await tick();
  f.release(); f.stream.stderr.write(Buffer.from('ready metadata\n'));
  const lease = await opening, chunks = [];
  lease.stderr.on('data', value => chunks.push(value)); await tick();
  assert.equal(Buffer.concat(chunks).toString(), 'ready metadata\n');
  f.finish(); await lease.exitPromise;
});

test('abort after open closes only its channel and preserves cancellation evidence', async () => {
  const f = fixture(), controller = new AbortController(), lease = await f.open({ signal: controller.signal });
  controller.abort(); assert.deepEqual(f.signals, ['TERM']); assert.equal(f.ends, 1);
  f.finish(null, 'TERM');
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'cancel'); assert.equal(result.signal, 'TERM'); assert.equal(f.clientEnds, 0);
  assert.equal(executionFailureDetails(result.error).code, 'SSH_EXECUTION_FAILED');
});

test('abort before acquisition and while connecting never dispatches', async () => {
  const controller = new AbortController(); controller.abort();
  const first = fixture();
  await assert.rejects(first.open({ signal: controller.signal }), error => executionFailureDetails(error).remoteOutcome === 'not_started');
  assert.equal(first.acquisitions, 0);
  let connected; const pending = new Promise(resolve => { connected = resolve; });
  const second = fixture({ connect: () => pending }), next = new AbortController();
  const opened = second.open({ signal: next.signal }); await tick(); next.abort(); connected();
  await assert.rejects(opened, error => executionFailureDetails(error).remoteOutcome === 'not_started');
  assert.equal(second.calls.length, 0);
});

test('abort during opening rejects once and destroys a late callback channel', async () => {
  const f = fixture({ deferred: true }), controller = new AbortController();
  const opened = f.open({ signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(opened, /Desktop helper cancel/);
  f.release(); await tick(); assert.equal(f.stream.destroyed, true); assert.equal(f.calls.length, 1); assert.equal(f.clientEnds, 0);
  f.stream.emit('error', Error('SYNTHETIC_PRIVATE late wire error'));
});

test('dispatch guard and changed profiles refuse before exec, including callback binding changes', async () => {
  const denied = fixture();
  await assert.rejects(denied.open({ beforeDispatch: async () => { throw Error('guard denied'); } }), /guard denied/);
  assert.equal(denied.calls.length, 0);
  const changed = fixture();
  await assert.rejects(changed.open({ beforeDispatch: async () => changed.changeProfile() }), error => dispatchFailureDetails(error).dispatchFailureStage === 'target_guard');
  assert.equal(changed.calls.length, 0);
  const late = fixture({ deferred: true }); const opening = late.open(); await tick(); late.changeProfile(); late.release();
  await assert.rejects(opening, error => dispatchFailureDetails(error).dispatchFailureStage === 'target_guard');
  assert.equal(late.stream.destroyed, true); assert.equal(late.clientEnds, 0);
});

test('profile tty, read-only and implicit workdir cannot change helper execution semantics', async () => {
  for (const profile of [{ tty: true }, { readOnly: true }, { workdir: '/untrusted' }]) {
    const f = fixture({ profile }); await assert.rejects(f.open(), /requires a writable non-PTY/); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  for (const value of ['', null, 'bad\0command']) await assert.rejects(f.open({ command: value }), /Invalid desktop helper/);
  assert.equal(f.acquisitions, 0);
});

test('stderr capture is bounded and overflow terminates with a typed result without entering stdout', async () => {
  const f = fixture(), lease = await f.open(), stdout = [];
  lease.stream.on('data', bytes => stdout.push(bytes));
  f.stream.stderr.write(Buffer.alloc(20 * 1024, 33));
  assert.deepEqual(f.signals, ['TERM']); assert.equal(f.ends, 1);
  f.finish(1);
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'stderr_limit'); assert.equal(result.stderr.receivedBytes, 20 * 1024);
  assert.equal(result.stderr.retainedBytes, 16 * 1024); assert.equal(result.stderr.truncated, true);
  assert.equal(executionFailureDetails(result.error).code, 'SSH_EXECUTION_FAILED'); assert.equal(Buffer.concat(stdout).length, 0);
});

test('nonzero exit is typed, duplicate exit/close and late errors cannot change its result', async () => {
  const f = fixture(), lease = await f.open(); f.finish(9);
  const result = await lease.exitPromise;
  f.stream.emit('exit', 0); f.stream.emit('close', 0); f.stream.emit('error', Error('SYNTHETIC_PRIVATE'));
  f.stream.stderr.emit('error', Error('SYNTHETIC_PRIVATE stderr'));
  assert.equal(await lease.exitPromise, result); assert.equal(result.exitCode, 9); assert.equal(result.reason, 'exit');
  assert.equal(executionFailureDetails(result.error).remoteOutcome, 'unknown'); assert.doesNotMatch(result.error.message, /SYNTHETIC_PRIVATE/);
});

test('transport loss before and after open has no automatic replay or false cleanup success', async () => {
  const pending = fixture({ deferred: true }), opening = pending.open(); await tick(); pending.client.emit('close');
  await assert.rejects(opening, /transport_lost/); pending.release(); await tick(); assert.equal(pending.stream.destroyed, true);
  const f = fixture(), lease = await f.open(); f.client.emit('error', Error('SYNTHETIC_PRIVATE transport'));
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'transport_lost'); assert.equal(result.cleanupComplete, false); assert.equal(result.remoteState, 'unknown');
  assert.equal(f.stream.destroyed, true); assert.equal(f.clientEnds, 0); assert.equal(f.calls.length, 1);
  assert.equal(executionFailureDetails(result.error).automaticReplay, false);
});

test('channel error and exit without close preserve bounded, unconfirmed cleanup results', async () => {
  const failed = fixture(), one = await failed.open(); failed.stream.emit('error', Error('SYNTHETIC_PRIVATE wire'));
  failed.finish(1); assert.equal((await one.exitPromise).reason, 'channel_error');
  const f = fixture(), lease = await f.open(); f.stream.emit('exit', 0);
  const result = await lease.exitPromise;
  assert.equal(result.reason, 'cleanup_timeout'); assert.equal(result.remoteState, 'exited'); assert.equal(result.exitCode, 0);
  assert.equal(result.cleanupComplete, false); assert.equal(f.stream.destroyed, true); assert.equal(f.clientEnds, 0);
});

test('channel opening refusal is typed and never automatically retries', async () => {
  const f = fixture({ deferred: true }), opening = f.open(); await tick(); f.release(Error('SYNTHETIC_PRIVATE refused'));
  await assert.rejects(opening, error => executionFailureDetails(error).code === 'SSH_EXECUTION_FAILED' && !error.message.includes('SYNTHETIC_PRIVATE'));
  assert.equal(f.calls.length, 1); assert.equal(f.clientEnds, 0);
});
