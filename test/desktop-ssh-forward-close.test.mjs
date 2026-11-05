import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { connect } from 'node:net';
import { openSshForward } from '../src/adapters/ssh/vendor.mjs';
import { openDesktopTunnel } from '../src/adapters/desktop/ssh-tunnel.mjs';

const require = createRequire(import.meta.url);
const { Channel, MAX_WINDOW, PACKET_SIZE } = require('ssh2/lib/Channel.js');
const { onCHANNEL_CLOSE } = require('ssh2/lib/utils.js');
assert.equal(require('ssh2/package.json').version, '1.17.0');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Only SSH packets/authentication are replaced. This is the installed ssh2
// Channel and its real protocol-CLOSE handler, including deferred end/close.
function fixture({ deferred = false, acknowledge = true } = {}) {
  const client = new EventEmitter(), profile = { name: 'fixture' }, events = [], calls = [];
  let callback, openEntered;
  const entered = new Promise(resolve => { openEntered = resolve; });
  const state = id => ({ id, state: 'open', window: MAX_WINDOW, packetSize: PACKET_SIZE });
  const stream = new Channel(client, { type: 'direct-tcpip', incoming: state(7), outgoing: state(9) });
  const sibling = new Channel(client, { type: 'direct-tcpip', incoming: state(8), outgoing: state(10) });
  sibling.push(Buffer.from('unrelated channel data'));
  client._chanMgr = { remove: id => { assert.equal(id, 7); } };
  const remoteClose = () => onCHANNEL_CLOSE(client, 7, stream);
  client._protocol = {
    channelEOF: id => { assert.equal(id, 9); calls.push('eof'); },
    channelClose: id => { assert.equal(id, 9); calls.push('close'); if (acknowledge) setImmediate(remoteClose); },
    channelData: () => {}, channelWindowAdjust: () => {},
  };
  client.end = client.destroy = () => assert.fail('shared SSH connection must remain open');
  client.forwardOut = (...args) => {
    callback = args.pop(); openEntered();
    if (!deferred) callback(null, stream);
  };
  for (const name of ['finish', 'end', 'close']) stream.on(name, () => events.push(name));
  const connection = { profile, ensureConnected: async () => {}, getClient: () => client };
  const registry = { getProfile: () => profile, getOrCreate: async () => connection };
  return { stream, sibling, events, calls, entered, remoteClose,
    release: () => callback(null, stream),
    open: options => openSshForward(registry, 'fixture', { host: '127.0.0.1', port: 3389, ...options }),
    assertSibling() {
      assert.equal(sibling.incoming.state, 'open'); assert.equal(sibling.outgoing.state, 'open');
      assert.equal(sibling.read().toString(), 'unrelated channel data');
    },
  };
}

test('forward close drains an empty paused ssh2 readable and observes protocol end/close', { timeout: 3000 }, async () => {
  const f = fixture(), lease = await f.open();
  f.stream.pause();
  f.remoteClose(); await tick();
  assert.equal(f.stream.readableLength, 0); assert.equal(f.stream.readableEnded, false);
  assert.deepEqual(f.events, ['finish'], 'protocol close is waiting on the paused readable EOF');
  const first = lease.close();
  assert.equal(lease.close(), first, 'one close operation per lease');
  await first;
  assert.equal(f.stream.readableEnded, true);
  assert.deepEqual(f.events, ['finish', 'end', 'close']);
  assert.deepEqual(f.calls, ['close']); f.assertSibling();
});

test('forward close discards buffered lease data without draining an unrelated channel', { timeout: 3000 }, async () => {
  const f = fixture(), lease = await f.open();
  f.stream.pause(); f.stream.push(Buffer.alloc(131072, 42));
  assert.equal(f.stream.readableLength, 131072);
  await lease.close();
  assert.equal(f.stream.readableLength, 0); assert.equal(f.stream.readableEnded, true);
  assert.equal(f.events.at(-1), 'close'); f.assertSibling();
});

test('tunnel teardown settles both real ssh2 pipelines after the native socket has closed', { timeout: 3000 }, async t => {
  const f = fixture(); let delivered;
  const ready = new Promise(resolve => { delivered = resolve; });
  const tunnel = await openDesktopTunnel({ openChannel: async options => {
    const lease = await f.open(options); delivered(); return lease;
  } });
  const socket = connect(tunnel.port, tunnel.host); socket.on('error', () => {});
  t.after(() => { socket.destroy(); f.stream.resume(); return tunnel.close(); });
  await ready; await tick(); f.stream.pause();
  socket.destroy();
  assert.deepEqual(await tunnel.close(), { closed: true, cleanupComplete: true });
  assert.equal(f.stream.readableEnded, true); assert.equal(f.events.at(-1), 'close');
  assert.deepEqual(f.calls, ['eof', 'close']); f.assertSibling();
});

test('missing SSH protocol close rejects cleanup instead of treating destroy/finish as closure', { timeout: 3000 }, async () => {
  const f = fixture({ acknowledge: false }), lease = await f.open();
  await assert.rejects(lease.close(), /cleanup unconfirmed/);
  assert.equal(f.stream.readableEnded, false); assert.equal(f.events.includes('close'), false);
  const closed = once(f.stream, 'close'); f.remoteClose(); await closed; f.assertSibling();
});

test('cancelled forward open drains and closes a late real ssh2 channel without replay', { timeout: 3000 }, async () => {
  const f = fixture({ deferred: true }), controller = new AbortController();
  const opening = f.open({ signal: controller.signal }); await f.entered; controller.abort();
  await assert.rejects(opening, /cancelled/);
  const closed = once(f.stream, 'close'); f.release(); await closed;
  assert.equal(f.stream.readableEnded, true); assert.deepEqual(f.calls, ['eof', 'close']); f.assertSibling();
});

test('opening timeout still drains a late callback channel and never closes the shared client', { timeout: 3000 }, async () => {
  const f = fixture({ deferred: true }), opening = f.open({ timeoutMs: 10 });
  await assert.rejects(opening, /opening timed out/);
  const closed = once(f.stream, 'close'); f.release(); await closed;
  assert.equal(f.events.at(-1), 'close'); f.assertSibling();
});
