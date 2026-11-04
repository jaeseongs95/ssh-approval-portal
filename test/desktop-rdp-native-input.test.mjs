import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { openNativeRdpInput } from '../src/adapters/desktop/rdp-native-input.mjs';

// Wire component tests against design r1 section 11. No Windows consumer is present.
const PATCH = 'ab'.repeat(32);
const INPUT_A = '41474e4901020000000000090000000000000001010000000000000141';
const RELEASE_2 = '41474e4901020000000000090000000000000002040000000000000101';
const CLOSE_3 = '41474e490104000000000001000000000000000301';
const ACK_A = '41474e4901030000000000180000000000000001000100000000000200000002ffffffff0600000000000000';
const HELLO_BODY = '0000001f0000268000800100000008000000100000002480010000000003002000010000'
  + 'bf217a504e54cc719880c228e82353382cd7d4fa' + PATCH;
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = value => [{ type: 'text', text: value }];
const code = expected => error => error.code === expected;

function frame(kind, seq, body) {
  const bytes = Buffer.alloc(20 + body.length);
  bytes.set(Buffer.from('41474e4901000000', 'hex')); bytes[5] = kind;
  bytes.writeUInt32BE(body.length, 8); bytes.writeBigUInt64BE(BigInt(seq), 12); bytes.set(body, 20);
  return bytes;
}
function hello() { return frame(1, 0, Buffer.from(HELLO_BODY, 'hex')); }
function ack(seq, { status = 0, scope = 1, error = 0, succeeded = 2, attempted = succeeded,
  action = 65535, element = 65535, phase = 6, flags = 0, held = 0, buttons = 0 } = {}) {
  const body = Buffer.alloc(24);
  body[0] = status; body[1] = scope; body.writeUInt16BE(error, 2);
  body.writeUInt32BE(succeeded, 4); body.writeUInt32BE(attempted, 8);
  body.writeUInt16BE(action, 12); body.writeUInt16BE(element, 14);
  body[16] = phase; body[17] = flags; body.writeUInt16BE(held, 18); body[20] = buttons;
  return frame(3, seq, body);
}
class NativeWire extends Duplex {
  writes = [];
  responder;
  _read() {}
  _write(bytes, encoding, done) {
    const copy = Buffer.from(bytes); this.writes.push(copy);
    if (this.responder) this.responder(copy, this, done); else done();
  }
  send(bytes) { this.push(Buffer.from(bytes)); }
}
async function open(options = {}) {
  const stream = new NativeWire();
  const pending = openNativeRdpInput({ stream, patchDigest: PATCH, width: 1024, height: 768, timeoutMs: 200, ...options });
  stream.send(hello());
  return { stream, port: await pending };
}
function autoAck(stream) {
  stream.responder = (bytes, wire, done) => {
    const release = bytes[5] === 2 && bytes[20] === 4;
    wire.send(ack(bytes.readBigUInt64BE(12), { flags: bytes[5] === 4 ? 6 : release ? 2 : 0 })); done();
  };
}
async function rejectedAck(options, expected = 'DESKTOP_NATIVE_INVALID_ACK', method = 'input') {
  const { stream, port } = await open();
  stream.responder = (bytes, wire, done) => { wire.send(ack(1, options)); done(); };
  await assert.rejects(method === 'input' ? port.input(text('A')) : port[method](), code(expected));
  assert.equal(port.closed, true); assert.equal(stream.destroyed, true);
  const count = stream.writes.length;
  await assert.rejects(port.input(text('B'))); assert.equal(stream.writes.length, count);
}

test('four literal section 11.6 oracles bind INPUT, RELEASE, CLOSE and received ACK', async () => {
  assert.equal(ack(1).toString('hex'), ACK_A);
  const { stream, port } = await open(); autoAck(stream);
  assert.deepEqual(await port.input(text('A')), { sent: true, scope: 'nativeSend' });
  assert.deepEqual(await port.release(), { sent: true, scope: 'nativeSend' });
  const closing = port.close(); assert.equal(port.close(), closing);
  assert.deepEqual(await closing, { sent: true, scope: 'nativeSend' });
  assert.deepEqual(stream.writes.map(bytes => bytes.toString('hex')), [INPUT_A, RELEASE_2, CLOSE_3]);
  assert.equal(stream.destroyed, true); assert.equal(port.closed, true);
  assert.deepEqual(await port.release(), { sent: false }); await port.close();
  await assert.rejects(port.input(text('A'))); assert.equal(stream.writes.length, 3);
});

test('HELLO tolerates every header/body split and sends no premature INPUT', async () => {
  const bytes = hello(); assert.equal(bytes.length, 108);
  for (let split = 1; split < bytes.length; split++) {
    const stream = new NativeWire(); let settled = false;
    const pending = openNativeRdpInput({ stream, patchDigest: PATCH, width: 1, height: 1, timeoutMs: 200 });
    pending.then(() => { settled = true; }); stream.send(bytes.subarray(0, split));
    await tick(); assert.equal(settled, false, `split ${split}`); assert.equal(stream.writes.length, 0);
    stream.send(bytes.subarray(split)); const port = await pending; stream.destroy(); assert.ok(port);
  }
});

test('ACK tolerates every split and resolves only after its full body', async () => {
  const bytes = Buffer.from(ACK_A, 'hex');
  for (let split = 1; split < bytes.length; split++) {
    const { stream, port } = await open(); let settled = false;
    const pending = port.input(text('A')); pending.then(() => { settled = true; });
    stream.send(bytes.subarray(0, split)); await tick(); assert.equal(settled, false, `split ${split}`);
    stream.send(bytes.subarray(split)); assert.equal((await pending).sent, true); stream.destroy();
  }
});

test('UTF-8 Korean/emoji and mixed action TLVs retain byte order and sequence', async () => {
  const { stream, port } = await open(); autoAck(stream);
  await port.input([{ type: 'text', text: '한😀' }, { type: 'key', keysym: 0xffe3, down: true },
    { type: 'pointer', x: 1023, y: 767, buttons: 5 }, { type: 'key', keysym: 0xffe3, down: false }]);
  assert.equal(stream.writes[0].subarray(20).toString('hex'),
    '0100000000000007ed959cf09f988002000000000000050000ffe301030000000000000503ff02ff0502000000000000050000ffe300');
  const mixed = '가'.repeat(21) + '😀' + '나'.repeat(21);
  await port.input(text(mixed));
  assert.equal(stream.writes[1].readBigUInt64BE(12), 2n);
  assert.equal(stream.writes[1].readUInt32BE(24), 130);
  assert.deepEqual(stream.writes[1].subarray(28), Buffer.from(mixed, 'utf8'));
  await port.close();
});

test('domain action, Unicode, geometry and aggregate bounds reject before write', async () => {
  const { stream, port } = await open(); autoAck(stream);
  const invalid = [[], Array.from({ length: 129 }, () => ({ type: 'key', keysym: 1, down: true })),
    text(''), text('\ud800'), text('A'.repeat(2049)), text('😀'.repeat(1025)),
    [text('A'.repeat(2048))[0], { type: 'key', keysym: 1, down: true }],
    [{ type: 'pointer', x: 1024, y: 0, buttons: 0 }], [{ type: 'pointer', x: 0, y: 768, buttons: 0 }],
    [{ type: 'key', keysym: 0, down: true }], [{ type: 'key', keysym: 1, down: 1 }], [{ type: 'release' }]];
  for (const actions of invalid) assert.throws(() => port.input(actions), code('DESKTOP_INVALID_INPUT'));
  assert.equal(stream.writes.length, 0);
  await port.close();
});

test('exact per-action UTF16, public event and 128-action boundaries remain usable', async () => {
  const { stream, port } = await open(); autoAck(stream);
  for (const actions of [text('한'.repeat(2048)), text('😀'.repeat(1024)),
    Array.from({ length: 128 }, () => ({ type: 'key', keysym: 0x1fffffff, down: false })),
    Array.from({ length: 128 }, () => ({ type: 'text', text: '한'.repeat(16) }))]) await port.input(actions);
  assert.deepEqual(stream.writes.map(bytes => bytes.readUInt32BE(8)), [6152, 4104, 1664, 7168]); await port.close();
});

test('HELLO header direction, lengths, sequence and every fixed capability reject', async t => {
  const mutations = [
    ['magic', b => { b[0] ^= 1; }], ['version', b => { b[4] = 2; }], ['direction', b => { b[5] = 2; }],
    ['flags', b => { b[7] = 1; }], ['short body', b => b.writeUInt32BE(87, 8)],
    ['oversize body', b => b.writeUInt32BE(9857, 8)], ['sequence', b => b.writeBigUInt64BE(1n, 12)],
    ...[0, 4, 8, 10, 12, 16, 20, 24, 25, 28, 30, 32, 34, 36, 56].map(offset =>
      [`HELLO body ${offset}`, b => { b[20 + offset] ^= 1; }]),
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const stream = new NativeWire(), bytes = hello(); mutate(bytes);
    const pending = openNativeRdpInput({ stream, patchDigest: PATCH, width: 1, height: 1, timeoutMs: 100 });
    stream.send(bytes);
    await assert.rejects(pending, error => ['DESKTOP_NATIVE_INVALID_FRAME', 'DESKTOP_NATIVE_CAPABILITY_MISMATCH'].includes(error.code));
    assert.equal(stream.writes.length, 0); assert.equal(stream.destroyed, true);
  });
});

test('ACK wrong direction, duplicate/gap sequence and invalid framing close without replay', async t => {
  const mutations = [['kind', b => { b[5] = 2; }], ['second HELLO', b => { b[5] = 1; }],
    ['duplicate', b => b.writeBigUInt64BE(0n, 12)], ['gap', b => b.writeBigUInt64BE(2n, 12)],
    ['flags', b => { b[6] = 1; }], ['length', b => b.writeUInt32BE(23, 8)], ['magic', b => { b[0] = 0; }]];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const { stream, port } = await open(); const bytes = ack(1); mutate(bytes);
    stream.responder = (request, wire, done) => { wire.send(bytes); done(); };
    await assert.rejects(port.input(text('A')), code('DESKTOP_NATIVE_INVALID_FRAME'));
    await assert.rejects(port.input(text('B'))); assert.equal(stream.writes.length, 1); assert.equal(stream.destroyed, true);
  });
});

test('ACK status, scope, counters, phase, flags, held state and reserved bytes are validated', async t => {
  const cases = [{ status: 3 }, { scope: 0 }, { error: 21 }, { succeeded: 3, attempted: 2 }, { attempted: 9345 },
    { phase: 7 }, { flags: 8 }, { held: 257 }, { buttons: 8 }, { status: 1 }, { status: 2, attempted: 0, succeeded: 0 },
    { status: 1, attempted: 0, succeeded: 0, error: 0 }, { error: 1 }, { attempted: 3 }, { action: 0 }, { element: 0 },
    { phase: 5 }, { flags: 2 }];
  for (const [index, options] of cases.entries()) await t.test(String(index), () => rejectedAck(options));
  await t.test('reserved', async () => {
    const { stream, port } = await open(); const bytes = ack(1); bytes[43] = 1;
    stream.responder = (request, wire, done) => { wire.send(bytes); done(); };
    await assert.rejects(port.input(text('A')), code('DESKTOP_NATIVE_INVALID_ACK')); assert.equal(stream.destroyed, true);
  });
});

test('rejected and partial/unknown receipts retain cursor and never retry or resume', async () => {
  for (const status of [1, 2]) {
    const { stream, port } = await open();
    const details = { status, error: status === 1 ? 14 : 13, succeeded: status === 1 ? 0 : 1,
      attempted: status === 1 ? 0 : 2, action: 2, element: 7, phase: status === 1 ? 0 : 2, flags: status === 1 ? 0 : 1 };
    stream.responder = (request, wire, done) => { wire.send(ack(1, details)); done(); };
    await assert.rejects(port.input(text('A')), error => {
      assert.equal(error.code, status === 1 ? 'DESKTOP_NATIVE_REJECTED' : 'DESKTOP_NATIVE_PARTIAL_OR_UNKNOWN');
      assert.deepEqual(error.nativeInput, { scope: 'nativeSend', status, errorCode: details.error,
        callsSucceeded: details.succeeded, callsAttempted: details.attempted, actionIndex: 2, elementIndex: 7,
        phase: details.phase, resultFlags: details.flags }); return true;
    });
    await assert.rejects(port.input(text('A'))); assert.deepEqual(await port.release(), { sent: false });
    assert.deepEqual(await port.close(), { sent: false }); assert.equal(stream.writes.length, 1);
  }
});

test('error ACK cannot claim an unrequested CLOSE or RELEASE or omit unknown native effect', async t => {
  // Section 11.4/11.5: CLOSE bit belongs to CLOSE; release bit only follows a requested release.
  for (const flags of [2, 4, 6]) await t.test(`INPUT error flags ${flags}`, () => rejectedAck({
    status: 1, error: 14, succeeded: 0, attempted: 0, action: 0, element: 0, phase: 0, flags,
  }));
  await t.test('callback FALSE must mark effect unknown', () => rejectedAck({
    status: 2, error: 13, succeeded: 0, attempted: 1, action: 0, element: 0, phase: 1, flags: 0,
  }));
});

test('concurrent duplicate calls do not write or replay while one request awaits ACK', async () => {
  const { stream, port } = await open(); const pending = port.input(text('A'));
  await assert.rejects(port.input(text('A')), code('DESKTOP_NATIVE_INPUT_BUSY'));
  await assert.rejects(port.release(), code('DESKTOP_NATIVE_INPUT_BUSY')); assert.equal(stream.writes.length, 1);
  stream.send(ack(1)); await pending; autoAck(stream);
  await port.input(text('B')); assert.equal(stream.writes[1].readBigUInt64BE(12), 2n); await port.close();
});

test('release/close require their own completion flags and empty held state', async t => {
  for (const method of ['release', 'close']) for (const options of [
    { flags: 0 }, { flags: method === 'close' ? 6 : 2, held: 1 }, { flags: method === 'close' ? 6 : 2, buttons: 1 },
  ]) await t.test(`${method} ${JSON.stringify(options)}`, () => rejectedAck(options, 'DESKTOP_NATIVE_INVALID_ACK', method));
});

test('no HELLO, incomplete HELLO and absent/incomplete ACK have bounded deadlines', async () => {
  for (const prefix of [Buffer.alloc(0), hello().subarray(0, 19), hello().subarray(0, 107)]) {
    const stream = new NativeWire();
    const pending = openNativeRdpInput({ stream, patchDigest: PATCH, width: 1, height: 1, timeoutMs: 20 });
    if (prefix.length) stream.send(prefix);
    await assert.rejects(pending, code('DESKTOP_NATIVE_ACK_TIMEOUT')); assert.equal(stream.destroyed, true);
  }
  for (const length of [0, 19, 43]) {
    const { stream, port } = await open({ timeoutMs: 20 }); const pending = port.input(text('A'));
    if (length) stream.send(ack(1).subarray(0, length));
    await assert.rejects(pending, code('DESKTOP_NATIVE_ACK_TIMEOUT'));
    await assert.rejects(port.input(text('B'))); assert.equal(stream.writes.length, 1); assert.equal(stream.destroyed, true);
  }
});

test('truncated EOF rejects, while a complete ACK buffered before EOF remains observable', async () => {
  for (const length of [0, 19, 43, 44]) {
    const { stream, port } = await open(); const pending = port.input(text('A'));
    if (length) stream.send(ack(1).subarray(0, length)); stream.push(null);
    if (length === 44) assert.equal((await pending).sent, true);
    else await assert.rejects(pending, code('DESKTOP_NATIVE_TRANSPORT_CLOSED'));
    await tick(); assert.equal(port.closed, true);
    await assert.rejects(port.input(text('B'))); assert.equal(stream.writes.length, 1); stream.destroy();
  }
});

test('pre-abort and cancellation during ACK wait prohibit later writes', async () => {
  const pre = new AbortController(); pre.abort(); const stream = new NativeWire();
  await assert.rejects(openNativeRdpInput({ stream, patchDigest: PATCH, width: 1, height: 1, signal: pre.signal }), code('DESKTOP_NATIVE_CANCELLED'));
  assert.equal(stream.writes.length, 0); assert.equal(stream.destroyed, true);
  const controller = new AbortController(); const { stream: wire, port } = await open({ signal: controller.signal });
  const pending = port.input(text('A')); controller.abort();
  await assert.rejects(pending, code('DESKTOP_NATIVE_CANCELLED'));
  await assert.rejects(port.input(text('B')), code('DESKTOP_NATIVE_CANCELLED'));
  assert.deepEqual(await port.release(), { sent: false }); assert.deepEqual(await port.close(), { sent: false });
  assert.equal(wire.writes.length, 1); assert.equal(wire.destroyed, true);
});

test('write callback failure, thrown write, stalled write and late transport errors stay terminal', async () => {
  for (const mode of ['callback', 'throw', 'stall']) {
    const { stream, port } = await open({ timeoutMs: 20 });
    stream.responder = (bytes, wire, done) => {
      if (mode === 'throw') throw Error('synthetic transport failure');
      if (mode === 'callback') done(Error('synthetic transport failure'));
    };
    await assert.rejects(port.input(text('A')), code(mode === 'stall' ? 'DESKTOP_NATIVE_ACK_TIMEOUT' : 'DESKTOP_NATIVE_TRANSPORT_FAILED'));
    stream.emit('error', Error('late synthetic error'));
    await assert.rejects(port.input(text('B'))); assert.equal(stream.writes.length, 1); assert.equal(stream.destroyed, true);
  }
});

test('wire buffering is bounded even before HELLO completes', async () => {
  const stream = new NativeWire();
  const pending = openNativeRdpInput({ stream, patchDigest: PATCH, width: 1, height: 1 });
  stream.send(Buffer.alloc(9985)); await assert.rejects(pending, code('DESKTOP_NATIVE_WIRE_LIMIT'));
  assert.equal(stream.destroyed, true); assert.equal(stream.writes.length, 0);
});
