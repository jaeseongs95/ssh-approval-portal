import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import ssh2Channels from 'ssh2/lib/Channel.js';
import { superviseExecution, DEFAULT_RUN_TIMEOUT_MS } from '../src/adapters/ssh/execution-supervisor.mjs';
import { executePythonSource, openSshForward, signalSshChannel } from '../src/adapters/ssh/vendor.mjs';
import { preparePythonSource } from '../src/adapters/ssh/python-source.mjs';

function wire({ deferred = false, closeCode } = {}) {
  const channel = new EventEmitter(), transport = new EventEmitter();
  Object.assign(channel, { stderr: new EventEmitter(), signals: [], writes: [], closes: 0, pauses: 0,
    signal(name) { this.signals.push(name); }, write(bytes) { this.writes.push(bytes); }, end() {},
    pause() { this.pauses++; }, resume() {}, close() { this.closes++; if (closeCode !== undefined) this.emit('close', closeCode); } });
  let callback, opens = 0;
  return { channel, transport, get opens() { return opens; }, release(error) { callback(error, error ? undefined : channel); },
    port: { open(_command, cb) { opens++; callback = cb; if (!deferred) cb(null, channel); },
      onTransportLost(fn) { transport.on('close', fn); return () => transport.removeListener('close', fn); } } };
}

test('owned execution preserves streaming UTF-8 bytes, stderr, exit and exact cursors', async () => {
  const f = wire(), output = [], p = superviseExecution(f.port, 'command', { onOutput: event => output.push(event) });
  const utf8 = Buffer.from('가🙂');
  f.channel.emit('data', utf8.subarray(0, 2)); f.channel.emit('data', utf8.subarray(2));
  f.channel.stderr.emit('data', Buffer.from('warning')); f.channel.emit('exit', 0); f.channel.emit('close', 0);
  const result = await p;
  assert.equal(result.stdout, '가🙂'); assert.equal(result.stderr, 'warning'); assert.equal(result.execution.reason, 'exit');
  assert.equal(result.execution.remoteState, 'exited'); assert.equal(result.execution.outputState, 'complete');
  assert.equal(result.execution.timeoutMs, DEFAULT_RUN_TIMEOUT_MS); assert.ok(DEFAULT_RUN_TIMEOUT_MS >= 120_000);
  assert.deepEqual(output.filter(x => x.stream === 'stdout').map(x => [x.cursor, x.nextCursor]), [[0, 2], [2, utf8.length]]);
  assert.equal(f.opens, 1); assert.equal(f.transport.listenerCount('close'), 0);
});

test('deadline keeps partial output and waits for close after a stop request', async () => {
  const f = wire(), controller = new AbortController();
  let settled = false;
  const p = superviseExecution(f.port, 'command', { timeoutMs: 5, stopGraceMs: 100, signal: controller.signal }).then(x => { settled = true; return x; });
  f.channel.emit('data', Buffer.from('before'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.equal(f.channel.signals[0], 'INT');
  f.channel.emit('exit', null, 'TERM'); f.channel.emit('close', null, 'TERM');
  const result = await p;
  assert.equal(result.stdout, 'before'); assert.equal(result.execution.reason, 'deadline');
  assert.equal(result.execution.remoteState, 'exited'); assert.equal(result.execution.cleanupComplete, true);
  assert.equal(result.execution.automaticReplay, false); assert.equal(f.opens, 1);
});

test('cancel is distinct from deadline and does not claim that a signal killed the process', async () => {
  const f = wire(), controller = new AbortController();
  const p = superviseExecution(f.port, 'command', { signal: controller.signal, stopGraceMs: 15 });
  f.channel.stderr.emit('data', Buffer.from('failure detail')); controller.abort();
  const result = await p;
  assert.equal(result.execution.reason, 'cancel'); assert.equal(result.stderr, 'failure detail');
  assert.equal(result.execution.remoteState, 'unknown'); assert.equal(result.execution.cleanupComplete, false);
  assert.equal(result.execution.requiresReconciliation, true); assert.equal(result.execution.outputState, 'partial');
  assert.deepEqual(f.channel.signals, ['INT', 'TERM', 'KILL']); assert.equal(f.opens, 1);
});

test('already cancelled work never dispatches', async () => {
  const f = wire(), controller = new AbortController(); controller.abort();
  const result = await superviseExecution(f.port, 'command', { signal: controller.signal });
  assert.equal(f.opens, 0); assert.equal(result.execution.remoteState, 'not_dispatched'); assert.equal(result.execution.reason, 'cancel');
});

test('pinned ssh2 channel signal crosses stdin EOF on the exact channel and waits for remote exit and cleanup', async () => {
  const controller = new AbortController(), client = new EventEmitter(), requests = [], input = [];
  const otherChannel = 92;
  let eof = false, channel;
  client._protocol = {
    channelData(id, bytes) { assert.equal(id, 91); input.push(Buffer.from(bytes)); },
    channelEOF(id) { assert.equal(id, 91); eof = true; },
    signal(id, name) {
      requests.push({ id, name }); assert.equal(eof, true); assert.equal(id, 91); assert.notEqual(id, otherChannel);
      queueMicrotask(() => { channel.emit('exit', null, 'SIGTERM'); channel.emit('close', null, 'SIGTERM'); });
    },
  };
  channel = new ssh2Channels.Channel(client, { type: 'session', incoming: { id: 1, state: 'open', window: 65536, packetSize: 32768 },
    outgoing: { id: 91, state: 'open', window: 65536, packetSize: 32768 } });
  const binding = { targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
  const profile = { readOnly: false, tty: false };
  client.exec = (_command, _options, callback) => callback(null, channel);
  const connection = { profile, ensureConnected: async () => {}, getClient: () => client, applyWorkdir: value => value, channelEnv: () => ({}) };
  const registry = { getProfile: () => profile, getOrCreate: async () => connection };
  const plan = preparePythonSource({ ...binding, source: "print('source stdin stays exact')\n", cwd: '/' });
  const pending = executePythonSource(registry, plan, () => binding, undefined, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.writable, false); assert.equal(channel.outgoing.state, 'eof');
  channel.signal('TERM'); assert.deepEqual(requests, [], 'ssh2 public method silently drops a post-EOF signal');
  controller.abort(); const result = await pending;
  assert.deepEqual(Buffer.concat(input), Buffer.from(plan.transportStdin ?? plan.stdin));
  assert.deepEqual(requests, [{ id: 91, name: 'INT' }]);
  assert.equal(result.execution.reason, 'cancel'); assert.equal(result.execution.signalDelivery, 'requested');
  assert.equal(result.execution.remoteState, 'exited'); assert.equal(result.execution.cleanupComplete, true);
  assert.equal(result.execution.requiresReconciliation, false);
});

test('signal port refuses foreign channels or unsupported internals instead of touching another transport', async () => {
  const calls = [], client = { _protocol: { signal: (...args) => calls.push(args) } };
  const channel = { type: 'session', server: false, _client: client, outgoing: { id: 3, state: 'eof' } };
  signalSshChannel(client, channel, 'TERM'); assert.deepEqual(calls, [[3, 'TERM']]);
  for (const changed of [{ ...channel, _client: {} }, { ...channel, outgoing: { id: 4, state: 'closed' } }, { ...channel, type: 'direct-tcpip' }]) {
    assert.throws(() => signalSshChannel(client, changed, 'KILL'), /unsupported/);
  }
  assert.throws(() => signalSshChannel({}, channel, 'KILL'), /unsupported/); assert.deepEqual(calls, [[3, 'TERM']]);
});

test('unsupported signal delivery remains explicit and never claims termination', async () => {
  const f = wire(), controller = new AbortController();
  f.port.signal = () => { throw Error('Unsupported transport'); };
  const pending = superviseExecution(f.port, 'command', { signal: controller.signal, stopGraceMs: 15 });
  controller.abort(); const result = await pending;
  assert.equal(result.execution.signalDelivery, 'unsupported'); assert.equal(result.execution.remoteState, 'unknown');
  assert.equal(result.execution.cleanupComplete, false); assert.equal(result.execution.automaticReplay, false);
});

test('transport loss preserves bytes and remains unknown even after local cleanup', async () => {
  const f = wire(), p = superviseExecution(f.port, 'command');
  f.channel.emit('data', Buffer.from('before')); f.transport.emit('close');
  const result = await p;
  assert.equal(result.stdout, 'before'); assert.equal(result.execution.reason, 'transport_lost');
  assert.equal(result.execution.remoteState, 'unknown'); assert.equal(result.execution.cleanupComplete, true);
  assert.equal(result.execution.requiresReconciliation, true); assert.equal(f.opens, 1);
});

test('late channel callback is stopped without another dispatch', async () => {
  const f = wire({ deferred: true });
  const result = await superviseExecution(f.port, 'command', { timeoutMs: 5, stopGraceMs: 10 });
  assert.equal(result.execution.reason, 'deadline'); assert.equal(result.execution.remoteState, 'unknown');
  f.release(); assert.deepEqual(f.channel.signals, ['KILL']); assert.equal(f.channel.closes, 1); assert.equal(f.opens, 1);
});

test('refused open is not dispatched; uncertain errors are never replayed', async () => {
  for (const [error, state] of [[Object.assign(Error('refused'), { reason: 1 }), 'not_dispatched'], [Error('lost reply'), 'unknown']]) {
    const f = wire({ deferred: true }), p = superviseExecution(f.port, 'command'); f.release(error);
    const result = await p;
    assert.equal(result.execution.reason, 'channel_open_failed'); assert.equal(result.execution.remoteState, state); assert.equal(f.opens, 1);
  }
});

test('byte retention is bounded for both streams and truncation is explicit', async () => {
  const f = wire(), output = [], p = superviseExecution(f.port, 'command', { maxOutputBytes: 4, onOutput: x => output.push(x) });
  f.channel.emit('data', Buffer.from('abcdefgh')); f.channel.stderr.emit('data', Buffer.from('123456'));
  f.channel.emit('close', 7);
  const result = await p;
  assert.equal(result.stdout, 'abcd'); assert.equal(result.stderr, '1234'); assert.equal(result.exitCode, 7);
  assert.deepEqual(result.execution.stdout, { receivedBytes: 8, retainedBytes: 4, cursor: 4, truncated: true });
  assert.deepEqual(result.execution.stderr, { receivedBytes: 6, retainedBytes: 4, cursor: 4, truncated: true });
  assert.equal(result.execution.outputState, 'partial'); assert.equal(output.reduce((n, x) => n + x.bytes.length, 0), 8);
});

test('sink failure and a stalled sink are bounded without erasing captured output', async () => {
  for (const onOutput of [() => { throw Error('storage unavailable'); }, () => new Promise(() => {})]) {
    const f = wire(), p = superviseExecution(f.port, 'command', { onOutput, stopGraceMs: 10 });
    f.channel.emit('data', Buffer.from('evidence')); f.channel.emit('close', 0);
    const result = await p;
    assert.equal(result.stdout, 'evidence'); assert.equal(result.execution.captureFailed, true);
    assert.equal(result.execution.outputState, 'partial'); assert.equal(result.exitCode, 0);
  }
});

for (const [reason, sinkFails] of [['exit', false], ['cancel', false], ['exit', true]]) test(`settlement drains a paused SSH readable after ${reason}; sink failure=${sinkFails}`, { timeout: 2000 }, async t => {
  const channel = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback(); } });
  channel.stderr = new PassThrough();
  const controller = new AbortController(), sink = Promise.withResolvers(), entered = Promise.withResolvers();
  let opens = 0, calls = 0, closes = 0;
  channel.signal = () => {};
  channel.close = () => {
    closes++; channel.push(null); channel.stderr.end();
    if (sinkFails) sink.reject(Error('Synthetic durable sink failure'));
    else sink.resolve();
  };
  t.after(() => { channel.destroy(); channel.stderr.destroy(); });
  const pending = superviseExecution({ open(_command, callback) { opens++; callback(null, channel); } }, 'command', {
    signal: controller.signal, stopGraceMs: 30,
    onOutput() { calls++; entered.resolve(); return sink.promise; },
  });
  // Exit/stop can precede the final data packet. Its grace timer must already be
  // running when output pauses the readable and starts the durable sink wait.
  if (reason === 'exit') channel.emit('exit', 0);
  else controller.abort();
  channel.push(Buffer.from('evidence'));
  await entered.promise;
  assert.equal(channel.isPaused(), true); assert.equal(channel.stderr.isPaused(), true);
  const result = await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.closed, true, 'A paused readable must drain EOF so SSH close can release its channel');
  assert.equal(result.stdout, 'evidence'); assert.equal(result.execution.reason, reason);
  assert.equal(result.execution.remoteState, reason === 'exit' ? 'exited' : 'unknown');
  assert.equal(result.execution.outputState, 'partial'); assert.equal(result.execution.captureFailed, sinkFails);
  assert.equal(result.execution.automaticReplay, false); assert.equal(opens, 1); assert.equal(calls, 1); assert.equal(closes, 1);
});

test('write failure is typed and keeps the channel slot through cleanup', async () => {
  const f = wire({ closeCode: 9 }); f.channel.write = () => { throw Error('write failed'); };
  const result = await superviseExecution(f.port, 'command', { stdin: 'payload', stopGraceMs: 10 });
  assert.equal(result.execution.reason, 'input_failed'); assert.equal(result.execution.remoteState, 'exited');
  assert.equal(result.execution.cleanupComplete, true); assert.equal(f.channel.closes, 1); assert.equal(f.opens, 1);
});

test('exit without close has bounded cleanup and preserves exit evidence', async () => {
  const f = wire(), p = superviseExecution(f.port, 'command', { stopGraceMs: 10 }); f.channel.emit('exit', 0);
  const result = await p;
  assert.equal(result.execution.reason, 'exit'); assert.equal(result.execution.remoteState, 'exited');
  assert.equal(result.execution.cleanupComplete, false); assert.equal(result.execution.requiresReconciliation, true);
  assert.equal(result.execution.outputState, 'partial');
});

test('source uses the owned channel port and rejects a stdin override before acquisition', async () => {
  const binding = { targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
  const plan = preparePythonSource({ ...binding, source: "print('ok')\n", cwd: '/' });
  const f = wire(), client = new EventEmitter(), profile = { readOnly: false, tty: false };
  client.exec = (_command, _options, callback) => { callback(null, f.channel); setImmediate(() => { f.channel.emit('data', Buffer.from('ok')); f.channel.emit('close', 0); }); };
  const connection = { profile, ensureConnected: async () => {}, getClient: () => client, applyWorkdir: x => x, channelEnv: () => ({}), exec: () => assert.fail('vendor Promise exec used') };
  let acquisitions = 0;
  const registry = { getProfile: () => profile, getOrCreate: async () => { acquisitions++; return connection; } };
  const result = await executePythonSource(registry, plan, () => binding);
  assert.equal(result.failed, false); assert.equal(result.data.stdout, 'ok'); assert.deepEqual(f.channel.writes, [plan.transportStdin ?? plan.stdin]);
  assert.equal(result.execution.remoteState, 'exited'); assert.equal(acquisitions, 1);
  await assert.rejects(executePythonSource(registry, plan, () => binding, undefined, { stdin: 'changed' }), /Invalid command transport options/);
  assert.equal(acquisitions, 1);
});

test('desktop forward cancellation closes only its channel and tracks exact endpoint', async () => {
  const client = new EventEmitter(), stream = new EventEmitter(), profile = { name: 'fixture' }, calls = [];
  stream.destroy = () => { stream.destroyed = true; stream.emit('close'); };
  client.forwardOut = (...args) => { const callback = args.pop(); calls.push(args); callback(null, stream); };
  client.end = () => assert.fail('shared transport ended');
  const connection = { profile, ensureConnected: async () => {}, getClient: () => client };
  const registry = { getProfile: () => profile, getOrCreate: async () => connection }, controller = new AbortController();
  const lease = await openSshForward(registry, 'fixture', { host: '127.0.0.1', port: 5900, signal: controller.signal });
  assert.equal(lease.stream, stream); assert.deepEqual(calls, [['127.0.0.1', 0, '127.0.0.1', 5900]]);
  controller.abort(); assert.equal(stream.destroyed, true);
  await assert.rejects(openSshForward(registry, 'fixture', { host: 'remote.example', port: 5900 }), /Invalid desktop/);
});
