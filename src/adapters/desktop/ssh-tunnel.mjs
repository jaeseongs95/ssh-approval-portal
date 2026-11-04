import { createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';

const fail = code => Object.assign(new Error(code), { code });

/** A bridge-local, lease-owned endpoint for a native RDP client. The remote
 * endpoint and SSH identity are selected by the composition root, never by MCP.
 * Closing this tunnel does not close the authenticated shared SSH connection. */
export async function openDesktopTunnel({ openChannel, signal, beforeDispatch = async () => {} }) {
  if (typeof openChannel !== 'function' || typeof beforeDispatch !== 'function') throw fail('DESKTOP_INVALID_CONFIG');
  if (signal?.aborted) throw fail('DESKTOP_CLOSED');
  const sockets = new Set(), openings = new Set(), channels = new Set();
  let closing, closed = false, closeError;
  const server = createServer(socket => {
    if (closed || sockets.size) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    const opening = Promise.resolve().then(async () => {
      await beforeDispatch();
      if (closed || socket.destroyed || signal?.aborted) return;
      const channel = await openChannel({ host: '127.0.0.1', port: 3389, signal, beforeDispatch });
      channels.add(channel);
      try {
        if (closed || socket.destroyed || signal?.aborted) return;
        // Keep errors local. Native-client diagnostics must not contain SSH
        // profile details, raw configuration, or a credential from this bridge.
        await Promise.all([pipeline(socket, channel.stream), pipeline(channel.stream, socket)]);
      } catch { socket.destroy(); }
      finally {
        try { await channel.close(); } catch { closeError = 'DESKTOP_TUNNEL_CLEANUP_UNKNOWN'; }
        channels.delete(channel);
      }
    }).catch(() => { socket.destroy(); });
    openings.add(opening);
    void opening.finally(() => openings.delete(opening));
  });
  server.on('error', () => {});
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      const stopped = new Promise(resolve => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      for (const socket of sockets) socket.destroy();
      for (const channel of channels) {
        try { await channel.close(); } catch { closeError = 'DESKTOP_TUNNEL_CLEANUP_UNKNOWN'; }
      }
      await Promise.allSettled([...openings]);
      await stopped;
      return { closed: true, cleanupComplete: !closeError, ...(closeError ? { errorCode: closeError } : {}) };
    })();
    return closing;
  };
  const onAbort = () => { void close(); };
  try {
    await new Promise((resolve, reject) => {
      const onError = () => { server.removeListener('listening', onReady); reject(fail('DESKTOP_TUNNEL_UNAVAILABLE')); };
      const onReady = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onReady);
      server.listen({ host: '127.0.0.1', port: 0 });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (closed || signal?.aborted) { await close(); throw fail('DESKTOP_CLOSED'); }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw fail('DESKTOP_TUNNEL_UNAVAILABLE');
    return { host: '127.0.0.1', port: address.port, close };
  } catch (error) { await close(); throw error; }
}
