import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { openDesktopTunnel } from '../src/adapters/desktop/ssh-tunnel.mjs';

function echoChannel(onClose = () => {}) {
  const stream = new Transform({ transform(bytes, encoding, next) { next(null, bytes); } });
  return { stream, close() { onClose(); stream.destroy(); } };
}

test('desktop RDP tunnel uses only bridge loopback and fixed remote RDP endpoint', async () => {
  let guarded = false, opened = 0;
  const tunnel = await openDesktopTunnel({ beforeDispatch: async () => { guarded = true; },
    openChannel: async options => {
      assert.equal(guarded, true); assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 3389);
      opened++; return echoChannel();
    } });
  const socket = connect(tunnel.port, tunnel.host);
  try {
    await once(socket, 'connect');
    const received = once(socket, 'data');
    socket.write(Buffer.from([0, 255, 13, 10]));
    assert.deepEqual((await received)[0], Buffer.from([0, 255, 13, 10]));
    assert.equal(opened, 1);
  } finally { socket.destroy(); }
  const closing = tunnel.close();
  assert.equal(tunnel.close(), closing);
  assert.deepEqual(await closing, { closed: true, cleanupComplete: true });
});

test('desktop tunnel cancellation before listen never creates an endpoint', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openDesktopTunnel({ signal: controller.signal, openChannel: async () => assert.fail('dispatched') }),
    { code: 'DESKTOP_CLOSED' });
});

test('desktop tunnel closes a late SSH channel before finishing cleanup', async () => {
  let finishOpen, opened;
  const reachedOpen = new Promise(resolve => { opened = resolve; });
  let closed = 0;
  const tunnel = await openDesktopTunnel({ openChannel: () => {
    opened(); return new Promise(resolve => { finishOpen = resolve; });
  } });
  const socket = connect(tunnel.port, tunnel.host);
  socket.on('error', () => {});
  await reachedOpen;
  const cleanup = tunnel.close();
  finishOpen(echoChannel(() => { closed++; }));
  assert.deepEqual(await cleanup, { closed: true, cleanupComplete: true });
  assert.equal(closed, 1); socket.destroy();
});

test('desktop tunnel retains an explicit cleanup failure', async () => {
  let reached;
  const opened = new Promise(resolve => { reached = resolve; });
  const stream = new Transform({ transform(bytes, encoding, next) { next(null, bytes); } });
  const tunnel = await openDesktopTunnel({ openChannel: async () => {
    reached(); return { stream, close() { stream.destroy(); throw Error('PRIVATE_CONNECTION_DETAIL'); } };
  } });
  const socket = connect(tunnel.port, tunnel.host); socket.on('error', () => {});
  await opened;
  const receipt = await tunnel.close();
  assert.equal(receipt.cleanupComplete, false);
  assert.equal(receipt.errorCode, 'DESKTOP_TUNNEL_CLEANUP_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_CONNECTION_DETAIL/);
  socket.destroy();
});

test('tunnel close cancels a pending channel open with its own lease signal', { timeout: 3000 }, async t => {
  let reached, cancel, aborted = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const tunnel = await openDesktopTunnel({ openChannel: ({ signal }) => new Promise((resolve, reject) => {
    cancel = () => { aborted = true; reject(Error('cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    reached();
  }) });
  const socket = connect(tunnel.port, tunnel.host); socket.on('error', () => {});
  t.after(() => { cancel?.(); socket.destroy(); return tunnel.close(); });
  await entered;
  assert.deepEqual(await tunnel.close(), { closed: true, cleanupComplete: true });
  assert.equal(aborted, true); socket.destroy();
});

test('unresponsive guard returns cleanup unknown and cannot dispatch after late completion', { timeout: 3000 }, async t => {
  let reached, release, opened = 0;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const tunnel = await openDesktopTunnel({ beforeDispatch: async () => { reached(); await gate; },
    openChannel: async () => { opened++; return echoChannel(); } });
  const socket = connect(tunnel.port, tunnel.host); socket.on('error', () => {});
  t.after(() => { release(); socket.destroy(); return tunnel.close(); });
  await entered;
  const receipt = await tunnel.close();
  assert.deepEqual(receipt, { closed: true, cleanupComplete: false, errorCode: 'DESKTOP_TUNNEL_CLEANUP_UNKNOWN' });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 0); assert.deepEqual(await tunnel.close(), receipt); socket.destroy();
});

test('unresponsive opener remains unknown and closes a channel delivered after the deadline once', { timeout: 3000 }, async t => {
  let reached, release, closes = 0, cleaned;
  const entered = new Promise(resolve => { reached = resolve; });
  const lateClosed = new Promise(resolve => { cleaned = resolve; });
  const tunnel = await openDesktopTunnel({ openChannel: () => { reached(); return new Promise(resolve => { release = resolve; }); } });
  const socket = connect(tunnel.port, tunnel.host); socket.on('error', () => {});
  t.after(() => { release?.(echoChannel()); socket.destroy(); return tunnel.close(); });
  await entered;
  const receipt = await tunnel.close();
  assert.equal(receipt.cleanupComplete, false); assert.equal(receipt.errorCode, 'DESKTOP_TUNNEL_CLEANUP_UNKNOWN');
  release(echoChannel(() => { closes++; cleaned(); })); await lateClosed;
  assert.equal(closes, 1); assert.deepEqual(await tunnel.close(), receipt); socket.destroy();
});
