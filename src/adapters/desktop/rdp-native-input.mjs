import { DesktopError, desktopActions, desktopFail } from '../../domain/desktop-lease.mjs';

const HEADER = 20, MAX_PAYLOAD = 9856, MAX_CALLS = 9344;
const UPSTREAM = 'bf217a504e54cc719880c228e82353382cd7d4fa';
const kinds = { hello: 1, input: 2, ack: 3, close: 4 };
const fault = code => new DesktopError('DESKTOP_NATIVE_' + code);

function frame(kind, sequence, body) {
  const header = Buffer.alloc(HEADER);
  header.write('AGNI'); header[4] = 1; header[5] = kind;
  header.writeUInt32BE(body.length, 8); header.writeBigUInt64BE(BigInt(sequence), 12);
  return Buffer.concat([header, body]);
}

function tlv(type, body) {
  const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function inputBody(actions, width, height) {
  const parts = desktopActions(actions, width, height).map(action => {
    if (action.type === 'text') return tlv(1, Buffer.from(action.text, 'utf8'));
    const body = Buffer.alloc(5);
    if (action.type === 'key') {
      body.writeUInt32BE(action.keysym); body[4] = Number(action.down); return tlv(2, body);
    }
    body.writeUInt16BE(action.x); body.writeUInt16BE(action.y, 2); body[4] = action.buttons;
    return tlv(3, body);
  });
  const result = Buffer.concat(parts);
  for (const bytes of parts) bytes.fill(0);
  if (result.length > MAX_PAYLOAD) { result.fill(0); desktopFail('DESKTOP_INVALID_INPUT'); }
  return result;
}

/** Private native-send receipts are not proof that a Windows application consumed input. */
export async function openNativeRdpInput({ stream, patchDigest, width, height, signal, timeoutMs = 60000 } = {}) {
  if (!stream || typeof stream.write !== 'function' || typeof stream.destroy !== 'function'
    || !/^[a-f0-9]{64}$/.test(patchDigest) || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 4096 || height > 4096
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) desktopFail('DESKTOP_INVALID_CONFIG');
  let buffered = Buffer.alloc(0), failure, wake, sequence = 0, busy = false, closed = false, closing;
  const failed = error => { failure ??= error; wake?.(); };
  const onData = bytes => {
    if (closed) return;
    if (buffered.length + bytes.length > HEADER + MAX_PAYLOAD + 108) {
      failed(fault('WIRE_LIMIT')); stream.destroy(); return;
    }
    const previous = buffered; buffered = Buffer.concat([buffered, bytes]); previous.fill(0); wake?.();
  };
  const onEnd = () => failed(fault('TRANSPORT_CLOSED'));
  const onError = () => failed(fault('TRANSPORT_FAILED'));
  const abort = () => { failed(fault('CANCELLED')); stream.destroy(); };
  stream.on('data', onData); stream.on('error', onError); stream.on('end', onEnd); stream.on('close', onEnd);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const dispose = () => {
    closed = true; buffered.fill(0); buffered = Buffer.alloc(0);
    stream.removeListener('data', onData); signal?.removeEventListener('abort', abort);
    // Keep the error listener for late native/pipe errors after destruction.
    stream.destroy(); failed(fault('TRANSPORT_CLOSED'));
  };
  const read = async (length, deadline) => {
    while (buffered.length < length) {
      if (failure) throw failure;
      const remaining = deadline - Date.now(); if (remaining <= 0) throw fault('ACK_TIMEOUT');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { wake = undefined; reject(fault('ACK_TIMEOUT')); }, remaining);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    const result = Buffer.from(buffered.subarray(0, length)), previous = buffered;
    buffered = Buffer.from(buffered.subarray(length)); previous.fill(0); return result;
  };
  const receive = async (kind, expectedSequence, deadline) => {
    const header = await read(HEADER, deadline);
    if (header.toString('ascii', 0, 4) !== 'AGNI' || header[4] !== 1 || header[5] !== kind
      || header.readUInt16BE(6) !== 0 || header.readUInt32BE(8) > MAX_PAYLOAD
      || header.readBigUInt64BE(12) !== BigInt(expectedSequence)) throw fault('INVALID_FRAME');
    const length = header.readUInt32BE(8);
    if (length !== (kind === kinds.hello ? 88 : 24)) throw fault('INVALID_FRAME');
    return read(length, deadline);
  };
  const write = (bytes, deadline) => new Promise((resolve, reject) => {
    if (failure || closed || stream.destroyed || !stream.writable) return reject(failure ?? fault('TRANSPORT_CLOSED'));
    const remaining = deadline - Date.now(); if (remaining <= 0) return reject(fault('ACK_TIMEOUT'));
    const timer = setTimeout(() => reject(fault('ACK_TIMEOUT')), remaining);
    try { stream.write(bytes, error => { clearTimeout(timer); error ? reject(fault('TRANSPORT_FAILED')) : resolve(); }); }
    catch { clearTimeout(timer); reject(fault('TRANSPORT_FAILED')); }
  });
  try {
    const hello = await receive(kinds.hello, 0, Date.now() + Math.min(timeoutMs, 10000));
    if (hello.readUInt32BE(0) !== 31 || hello.readUInt32BE(4) !== MAX_PAYLOAD
      || hello.readUInt16BE(8) !== 128 || hello.readUInt16BE(10) !== 256
      || hello.readUInt32BE(12) !== 2048 || hello.readUInt32BE(16) !== 4096
      || hello.readUInt32BE(20) !== MAX_CALLS || hello[24] !== 1
      || hello.subarray(25, 28).some(Boolean) || hello.readUInt16BE(28) !== 3
      || hello.readUInt16BE(30) !== 32 || hello.readUInt16BE(32) !== 1 || hello.readUInt16BE(34) !== 0
      || hello.subarray(36, 56).toString('hex') !== UPSTREAM
      || hello.subarray(56, 88).toString('hex') !== patchDigest) throw fault('CAPABILITY_MISMATCH');
  } catch (error) { dispose(); throw error; }

  const exchange = async (kind, body, mode) => {
    if (busy) { body.fill(0); throw fault('INPUT_BUSY'); }
    if (closed || failure || sequence === Number.MAX_SAFE_INTEGER) { body.fill(0); throw failure ?? fault('TRANSPORT_CLOSED'); }
    busy = true;
    const bytes = frame(kind, ++sequence, body), deadline = Date.now() + timeoutMs;
    body.fill(0);
    try {
      await write(bytes, deadline); bytes.fill(0);
      const ack = await receive(kinds.ack, sequence, deadline);
      const status = ack[0], code = ack.readUInt16BE(2), succeeded = ack.readUInt32BE(4), attempted = ack.readUInt32BE(8);
      const flags = ack[17], held = ack.readUInt16BE(18), buttons = ack[20];
      if (status > 2 || ack[1] !== 1 || code > 20 || succeeded > attempted || attempted > MAX_CALLS
        || ack[16] > 6 || flags > 7 || held > 256 || (buttons & ~0x87) !== 0 || ack.subarray(21).some(Boolean)
        || status === 1 && (attempted !== 0 || (flags & 1) !== 0) || status === 2 && attempted === 0 || status !== 0 && code === 0
        || mode === 'input' && (flags & 6) !== 0 || mode === 'release' && (flags & 4) !== 0
        || mode === 'close' && (flags & 4) === 0 || (flags & 2) !== 0 && (held !== 0 || buttons !== 0)
        || code === 13 && ((flags & 1) === 0 || attempted !== succeeded + 1)) throw fault('INVALID_ACK');
      if (status !== 0) {
        const error = fault(status === 1 ? 'REJECTED' : 'PARTIAL_OR_UNKNOWN');
        error.nativeInput = { scope: 'nativeSend', status, errorCode: code, callsSucceeded: succeeded, callsAttempted: attempted,
          actionIndex: ack.readUInt16BE(12), elementIndex: ack.readUInt16BE(14), phase: ack[16], resultFlags: flags };
        throw error;
      }
      const expectedFlags = mode === 'close' ? 6 : mode === 'release' ? 2 : 0;
      if (code !== 0 || succeeded !== attempted || ack.readUInt32BE(12) !== 0xffffffff || ack[16] !== 6
        || flags !== expectedFlags || mode !== 'input' && (held !== 0 || buttons !== 0)) throw fault('INVALID_ACK');
      return { sent: true, scope: 'nativeSend' };
    } catch (error) { dispose(); throw error; }
    finally { bytes.fill(0); busy = false; }
  };
  return {
    get closed() { return closed || Boolean(failure); },
    input: actions => exchange(kinds.input, inputBody(actions, width, height), 'input'),
    release: () => closed || failure ? Promise.resolve({ sent: false }) : exchange(kinds.input, tlv(4, Buffer.from([1])), 'release'),
    close() {
      return closing ??= (async () => {
        if (closed || failure) return { sent: false };
        try { return await exchange(kinds.close, Buffer.from([1]), 'close'); }
        finally { dispose(); }
      })();
    },
  };
}
