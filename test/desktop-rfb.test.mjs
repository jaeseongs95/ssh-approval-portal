import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { inflateSync, crc32 } from 'node:zlib';
import { createRfbDesktopAdapter } from '../src/adapters/desktop/rfb.mjs';

function server({ version = '003.008', huge = false } = {}) {
  let phase = 0, size = 2;
  const writes = []; const state = { resize: false };
  const send = bytes => { for (let i = 0; i < bytes.length; i += 3) stream.push(bytes.subarray(i, i + 3)); };
  const stream = new Duplex({ read() {}, write(bytes, encoding, callback) {
    writes.push(Buffer.from(bytes));
    if (phase === 0) { phase++; send(Buffer.from([1, 1])); }
    else if (phase === 1) { phase++; send(Buffer.alloc(4)); }
    else if (phase === 2) { phase++; const init = Buffer.alloc(24); init.writeUInt16BE(huge ? 65535 : size); init.writeUInt16BE(huge ? 65535 : size, 2); send(init); }
    else if (bytes[0] === 3) {
      const header = Buffer.alloc(16); header.writeUInt16BE(1, 2);
      if (state.resize) { size = 3; state.resize = false; header.writeUInt16BE(size, 8); header.writeUInt16BE(size, 10); header.writeInt32BE(-223, 12); send(header); }
      else { header.writeUInt16BE(size, 8); header.writeUInt16BE(size, 10); send(Buffer.concat([header, Buffer.alloc(size * size * 4, 0x55)])); }
    }
    callback();
  } });
  queueMicrotask(() => send(Buffer.from(`RFB ${version}\n`)));
  return { stream, writes, state, openChannel: async args => { assert.equal(args.host, '127.0.0.1'); return { stream, close() { stream.destroy(); } }; } };
}

test('RFB fragmented raw framebuffer is a valid PNG; resize changes geometry and held inputs release', async () => {
  const fixture = server(), adapter = createRfbDesktopAdapter({ openChannel: fixture.openChannel, allowNoneSecurity: true });
  const desktop = await adapter.open({ binding: {} });
  const first = await desktop.observe();
  assert.equal(first.width, 2); assert.equal(first.height, 2); assert.equal(first.geometryRevision, 1);
  assert.equal(first.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8, image;
  while (offset < first.data.length) {
    const length = first.data.readUInt32BE(offset), type = first.data.toString('ascii', offset + 4, offset + 8), body = first.data.subarray(offset + 8, offset + 8 + length);
    assert.equal(first.data.readUInt32BE(offset + 8 + length), crc32(first.data.subarray(offset + 4, offset + 8 + length)));
    if (type === 'IDAT') image = inflateSync(body); offset += 12 + length;
  }
  assert.equal(image.length, 18); assert.deepEqual([...image.subarray(1, 5)], [85, 85, 85, 255]);
  fixture.state.resize = true; const second = await desktop.observe(); assert.equal(second.width, 3); assert.equal(second.geometryRevision, 2);
  await desktop.input([{ type: 'key', keysym: 0xffe1, down: true }, { type: 'pointer', x: 1, y: 1, buttons: 1 }]);
  await desktop.close();
  assert.equal(fixture.writes.filter(bytes => bytes[0] === 4).at(-1)[1], 0);
  assert.equal(fixture.writes.filter(bytes => bytes[0] === 5).at(-1)[1], 0); assert.equal(desktop.closed, true);
});

test('RFB refuses unconfigured security, unsupported version and oversized server framebuffer', async () => {
  let opened = false;
  await assert.rejects(createRfbDesktopAdapter({ openChannel: async () => { opened = true; } }).open({}), error => error.code === 'DESKTOP_NOT_CONFIGURED');
  assert.equal(opened, false);
  for (const options of [{ version: '003.007' }, { huge: true }]) {
    const fixture = server(options);
    await assert.rejects(createRfbDesktopAdapter({ openChannel: fixture.openChannel, allowNoneSecurity: true }).open({}), error => ['DESKTOP_UNSUPPORTED_RFB_VERSION', 'DESKTOP_FRAME_LIMIT'].includes(error.code));
    assert.equal(fixture.stream.destroyed, true);
  }
});
