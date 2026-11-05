import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { createRfbDesktopAdapter } from '../src/adapters/desktop/rfb.mjs';

test('RFB text KeyEvent는 ASCII와 Unicode keysym을 network byte order로 전송한다', async () => {
  let phase = 0;
  const events = [];
  const stream = new Duplex({ read() {}, write(bytes, encoding, callback) {
    if (phase === 0) { phase++; stream.push(Buffer.from([1, 1])); }
    else if (phase === 1) { phase++; stream.push(Buffer.alloc(4)); }
    else if (phase === 2) { phase++; const init = Buffer.alloc(24); init.writeUInt16BE(64, 0); init.writeUInt16BE(64, 2); stream.push(init); }
    else if (bytes[0] === 4) events.push(Buffer.from(bytes));
    callback();
  } });
  queueMicrotask(() => stream.push(Buffer.from('RFB 003.008\n')));
  const desktop = await createRfbDesktopAdapter({ allowNoneSecurity: true,
    openChannel: async () => ({ stream, close: () => stream.destroy() }) }).open({ binding: {} });
  await desktop.input([{ type: 'text', text: 'Aa:한😀' }]);
  // RFB 3.8 KeyEvent: type, down, padding(2), keysym U32 big endian.
  assert.deepEqual(events.map(value => value.toString('hex')), [
    '0401000000000041', '0400000000000041',
    '0401000000000061', '0400000000000061',
    '040100000000003a', '040000000000003a',
    '040100000100d55c', '040000000100d55c',
    '040100000101f600', '040000000101f600',
  ]);
  assert.deepEqual(events.filter((_, index) => index % 2 === 0).map(value => value.readUInt32BE(4)),
    [0x41, 0x61, 0x3a, 0x0100d55c, 0x0101f600]);
  assert.notEqual(events[0].readUInt32LE(4), 0x41);
  await desktop.close();
});
