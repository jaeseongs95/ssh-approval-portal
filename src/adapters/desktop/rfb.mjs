import { crc32, deflateSync } from 'node:zlib';
import { desktopFail, DesktopError, desktopActions } from '../../domain/desktop-lease.mjs';

const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([u32(data.length), body, u32(crc32(body))]); };
function png(width, height, pixels) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, destination = y * (width * 4 + 1) + 1 + x * 4;
    scanlines[destination] = pixels[source + 2]; scanlines[destination + 1] = pixels[source + 1];
    scanlines[destination + 2] = pixels[source]; scanlines[destination + 3] = 255;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

/** One bounded reader; callers serialize observation. No reconnect or input replay. */
function reader(stream, maxBytes) {
  const buffers = []; let available = 0, failure, wake;
  const fail = error => { failure ??= error; wake?.(); };
  const data = bytes => {
    if (available + bytes.length > maxBytes || buffers.length >= 8192) { fail(new DesktopError('DESKTOP_WIRE_LIMIT')); stream.destroy(); return; }
    buffers.push(Buffer.from(bytes)); available += bytes.length; wake?.();
  };
  const closed = () => fail(new DesktopError('DESKTOP_TRANSPORT_CLOSED'));
  const error = () => fail(new DesktopError('DESKTOP_TRANSPORT_FAILED'));
  stream.on('data', data); stream.on('error', error); stream.on('end', closed); stream.on('close', closed);
  return {
    get closed() { return Boolean(failure); },
    async read(length, deadline) {
      if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) desktopFail('DESKTOP_WIRE_LIMIT');
      while (available < length) {
        if (failure) throw failure;
        const remaining = deadline - Date.now(); if (remaining <= 0) desktopFail('DESKTOP_TIMEOUT');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { wake = undefined; reject(new DesktopError('DESKTOP_TIMEOUT')); }, remaining);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        });
      }
      if (failure) throw failure;
      const result = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const first = buffers[0], size = Math.min(first.length, length - offset);
        first.copy(result, offset, 0, size); offset += size; available -= size;
        if (size === first.length) buffers.shift(); else buffers[0] = first.subarray(size);
      }
      return result;
    },
    close() { stream.removeListener('data', data); buffers.length = 0; available = 0; closed(); },
  };
}

/** RFC 6143 RFB 3.8, Raw + DesktopSize. OS capture/login is the VNC server's responsibility.
 * openChannel must use an authorized SSH direct-tcpip channel to target loopback.
 * None security is explicit opt-in: SSH authenticates the transport, not local host users.
 */
export function createRfbDesktopAdapter({ openChannel, port = 5900, allowNoneSecurity = false,
  maxPixels = 4_194_304, timeoutMs = 10_000 } = {}) {
  if (typeof openChannel !== 'function' || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 4_194_304
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) desktopFail('DESKTOP_INVALID_CONFIG');
  return {
    async open({ binding, signal } = {}) {
      if (!allowNoneSecurity) desktopFail('DESKTOP_NOT_CONFIGURED');
      signal?.throwIfAborted();
      const channel = await openChannel({ binding, host: '127.0.0.1', port, signal });
      const { stream } = channel;
      if (!stream || typeof stream.write !== 'function' || typeof stream.destroy !== 'function') { await channel.close?.(); desktopFail('DESKTOP_INVALID_CHANNEL'); }
      const wire = reader(stream, maxPixels * 8 + 65536), keys = new Set();
      let width, height, pixels, geometryRevision = 0, closed = false, stopping = false, closing, releaseWork, pointer = { x: 0, y: 0, buttons: 0 };
      const write = bytes => {
        if (closed || wire.closed || stream.destroyed || !stream.writable) desktopFail('DESKTOP_TRANSPORT_CLOSED');
        stream.write(bytes);
      };
      const flush = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DesktopError('DESKTOP_WRITE_TIMEOUT')), Math.min(timeoutMs, 1000));
        stream.write(Buffer.alloc(0), error => { clearTimeout(timer); error ? reject(new DesktopError('DESKTOP_TRANSPORT_FAILED')) : resolve(); });
      });
      const dimensions = (w, h) => {
        if (!w || !h || w * h > maxPixels) desktopFail('DESKTOP_FRAME_LIMIT');
        if (w !== width || h !== height) { width = w; height = h; pixels = Buffer.alloc(w * h * 4); geometryRevision++; }
      };
      const key = (keysym, down) => {
        if (down && !keys.has(keysym) && keys.size >= 256) desktopFail('DESKTOP_KEY_LIMIT');
        const bytes = Buffer.alloc(8); bytes[0] = 4; bytes[1] = Number(down); bytes.writeUInt32BE(keysym, 4);
        write(bytes); if (down) keys.add(keysym); else keys.delete(keysym);
      };
      const point = (x, y, buttons) => {
        const bytes = Buffer.alloc(6); bytes[0] = 5; bytes[1] = buttons; bytes.writeUInt16BE(x, 2); bytes.writeUInt16BE(y, 4);
        write(bytes); pointer = { x, y, buttons };
      };
      const release = () => releaseWork ??= (async () => {
        stopping = true;
        if (closed || wire.closed || stream.destroyed) { keys.clear(); pointer.buttons = 0; return { sent: false }; }
        for (const keysym of [...keys]) key(keysym, false);
        if (pointer.buttons) point(Math.min(pointer.x, width - 1), Math.min(pointer.y, height - 1), 0);
        await flush(); return { sent: true };
      })();
      const close = () => closing ??= (async () => {
        if (closed) return;
        try { await release(); }
        finally {
          closed = true; signal?.removeEventListener('abort', abort); wire.close();
          try { await channel.close?.(); } finally { stream.destroy(); }
        }
      })();
      const abort = () => { void close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const deadline = Date.now() + timeoutMs;
        if ((await wire.read(12, deadline)).toString('ascii') !== 'RFB 003.008\n') desktopFail('DESKTOP_UNSUPPORTED_RFB_VERSION');
        write(Buffer.from('RFB 003.008\n'));
        const count = (await wire.read(1, deadline))[0];
        if (!count || !(await wire.read(count, deadline)).includes(1)) desktopFail('DESKTOP_UNSUPPORTED_SECURITY');
        write(Buffer.from([1]));
        if ((await wire.read(4, deadline)).readUInt32BE() !== 0) desktopFail('DESKTOP_AUTH_FAILED');
        write(Buffer.from([1])); // Shared session; never disconnect another viewer.
        const init = await wire.read(24, deadline); dimensions(init.readUInt16BE(), init.readUInt16BE(2));
        const nameLength = init.readUInt32BE(20); if (nameLength > 4096) desktopFail('DESKTOP_WIRE_LIMIT');
        await wire.read(nameLength, deadline); // Server name can contain private data; do not expose/log it.
        const format = Buffer.alloc(20); format[4] = 32; format[5] = 24; format[7] = 1;
        format.writeUInt16BE(255, 8); format.writeUInt16BE(255, 10); format.writeUInt16BE(255, 12); format[14] = 16; format[15] = 8;
        write(format);
        const encodings = Buffer.alloc(12); encodings[0] = 2; encodings.writeUInt16BE(2, 2); encodings.writeInt32BE(0, 4); encodings.writeInt32BE(-223, 8); write(encodings);
        return {
          get closed() { return closed || wire.closed; },
          async observe({ includeImage = true } = {}) {
            const deadline = Date.now() + timeoutMs; let messages = 0, totalPixels = 0;
            for (let attempts = 0; attempts < 4; attempts++) {
              const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8); write(request);
              let resized = false;
              while (true) {
                if (++messages > 256) desktopFail('DESKTOP_WIRE_LIMIT');
                const type = (await wire.read(1, deadline))[0];
                if (type === 2) continue; // Bell.
                if (type === 3) { const header = await wire.read(7, deadline), length = header.readUInt32BE(3); if (length > 65536) desktopFail('DESKTOP_WIRE_LIMIT'); await wire.read(length, deadline); continue; }
                if (type !== 0) desktopFail('DESKTOP_UNSUPPORTED_MESSAGE');
                const count = (await wire.read(3, deadline)).readUInt16BE(1); if (count > 4096) desktopFail('DESKTOP_WIRE_LIMIT');
                for (let i = 0; i < count; i++) {
                  const rectangle = await wire.read(12, deadline), x = rectangle.readUInt16BE(), y = rectangle.readUInt16BE(2), w = rectangle.readUInt16BE(4), h = rectangle.readUInt16BE(6), encoding = rectangle.readInt32BE(8);
                  if (encoding === -223) { dimensions(w, h); resized = true; continue; }
                  if (encoding !== 0) desktopFail('DESKTOP_UNSUPPORTED_ENCODING');
                  if (!w || !h || x + w > width || y + h > height || (totalPixels += w * h) > maxPixels * 2) desktopFail('DESKTOP_FRAME_LIMIT');
                  const bytes = await wire.read(w * h * 4, deadline);
                  for (let row = 0; row < h; row++) bytes.copy(pixels, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
                }
                break;
              }
              if (!resized) return { width, height, geometryRevision, ...(includeImage ? { data: png(width, height, pixels) } : {}) };
            }
            desktopFail('DESKTOP_UNSTABLE_GEOMETRY');
          },
          async input(actions) {
            if (stopping) desktopFail('DESKTOP_CLOSED');
            for (const action of desktopActions(actions, width, height)) {
              signal?.throwIfAborted();
              if (action.type === 'key') key(action.keysym, action.down);
              else if (action.type === 'pointer') point(action.x, action.y, action.buttons);
              else for (const character of action.text) {
                const code = character.codePointAt(0), keysym = code === 10 ? 0xff0d : code === 9 ? 0xff09 : code < 256 ? code : 0x1000000 + code;
                key(keysym, true); key(keysym, false);
              }
            }
            await flush();
          },
          release, close,
        };
      } catch (error) {
        try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError.code ?? 'DESKTOP_CLEANUP_FAILED'; }
        throw error;
      }
    },
  };
}
