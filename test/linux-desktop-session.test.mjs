import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLinuxSessionDesktopAdapter } from '../src/adapters/desktop/linux-session.mjs';

// 실제 GUI 시험은 TEST 서버에서만 명시적으로 활성화한다. 일반 단위시험은 OS 무관하다.
const integration = { skip: process.env.AGS_TEST_LINUX_GUI !== '1' };
const binding = { ownerId: 'linux-gui-test', targetId: 'default', targetRevision: 'a'.repeat(64), epoch: 1 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await sleep(25); } while (Date.now() < deadline);
  assert.fail('조건이 제한 시간 안에 충족되어야 한다');
}
const exists = path => access(path).then(() => true, () => false);
const hash = value => createHash('sha256').update(value).digest('hex');
const rdpApplication = { kind: 'rdp', host: '127.0.0.1', port: 3389,
  executable: '/opt/ssh-approval/release/native/freerdp-input/runtime/bin/xfreerdp3',
  executableSha256: 'b'.repeat(64), patchDigest: 'c'.repeat(64), width: 800, height: 600, certificateMode: 'ssh-tunnel' };

function fixture(options = {}) {
  const channels = [];
  const adapter = createLinuxSessionDesktopAdapter({ width: 800, height: 600, ttlMs: 30000, ...options,
    async openSession({ command }) {
      const child = spawn('/bin/sh', ['-c', 'exec ' + command], { stdio: ['pipe', 'pipe', 'pipe'] });
      const stream = Duplex.from({ writable: child.stdin, readable: child.stdout });
      const stderr = new PassThrough(), events = [];
      let pending = '';
      child.stderr.on('data', bytes => {
        pending += bytes.toString();
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (options.dropClosedReceipt && event.event === 'closed') continue;
          stderr.write(line + '\n');
        }
      });
      child.stderr.once('end', () => stderr.end());
      child.once('close', (exitCode, signal) => {
        if (exitCode !== 0) console.log(JSON.stringify({ case: 'helper-failure', exitCode, signal, events }));
      });
      const exitPromise = new Promise(resolve => child.once('close', (exitCode, signal) =>
        resolve({ exitCode, signal, remoteState: 'exited', cleanupComplete: true })));
      const channel = { stream, stderr, exitPromise, events, child, command,
        async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exitPromise; } };
      channels.push(channel); return channel;
    },
  });
  return { adapter, channels };
}
const ready = channel => channel.events.find(event => event.event === 'ready');
async function assertGone(channel) {
  await eventually(async () => (await Promise.all(ready(channel).pids.map(pid => exists('/proc/' + pid)))).every(value => !value));
}

test('Linux 관리형 세션의 경계값을 실행 전에 거절한다', () => {
  for (const config of [{}, { openSession() {}, width: 1 }, { openSession() {}, width: 4096, height: 4096 },
    { openSession() {}, ttlMs: 999 }, { openSession() {}, ttlMs: 900001 }]) {
    assert.throws(() => createLinuxSessionDesktopAdapter(config), error => error.code === 'DESKTOP_INVALID_CONFIG');
  }
});

test('RDP application은 고정 loopback·클라이언트·인증 모드만 허용한다', () => {
  const application = rdpApplication;
  const config = { openSession() {}, width: 800, height: 600, application, writeBootstrap() {} };
  assert.doesNotThrow(() => createLinuxSessionDesktopAdapter(config));
  for (const change of [{ host: 'example.com' }, { executable: '/tmp/client' }, { executable: '/usr/bin/xfreerdp3' },
    { executableSha256: undefined }, { patchDigest: 'bad' }, { port: 0 },
    { certificateMode: 'ignore' }, { width: 900 }, { command: '/bin/sh' }, { password: 'forbidden' }]) {
    assert.throws(() => createLinuxSessionDesktopAdapter({ ...config, application: { ...application, ...change } }),
      error => error.code === 'DESKTOP_INVALID_CONFIG');
  }
  assert.throws(() => createLinuxSessionDesktopAdapter({ ...config, writeBootstrap: undefined }),
    error => error.code === 'DESKTOP_INVALID_CONFIG');
});

test('RDP bootstrap 실패는 RFB 전에 원 오류를 보존하고 채널을 닫는다', async () => {
  const stream = new PassThrough(), inputStream = new PassThrough(), failure = Error('credential-provider-failed');
  let calls = 0, closes = 0, command;
  const adapter = createLinuxSessionDesktopAdapter({ width: 800, height: 600,
    application: rdpApplication,
    async openSession(options) { assert.equal(options.nativeInput, true); command = options.command; return { stream, inputStream, stderr: new PassThrough(),
      exitPromise: Promise.resolve({ exitCode: 1, remoteState: 'exited' }), async close() { closes++; } }; },
    async writeBootstrap(writable) { assert.equal(writable, stream); calls++; throw failure; },
  });
  await assert.rejects(adapter.open({ binding }), error => error === failure);
  assert.equal(calls, 1); assert.equal(closes, 1);
  assert.equal(inputStream.destroyed, true);
  assert.ok(Buffer.byteLength(command) <= 32768); assert.ok(!command.includes(failure.message));
});

test('RDP fd3가 없으면 credential 공급자를 호출하지 않는다', async () => {
  let bootstraps = 0, closes = 0;
  const adapter = createLinuxSessionDesktopAdapter({ width: 800, height: 600, application: rdpApplication,
    async openSession({ nativeInput }) { assert.equal(nativeInput, true); return {
      stream: new PassThrough(), stderr: new PassThrough(), exitPromise: Promise.resolve({ exitCode: 1 }),
      async close() { closes++; } }; },
    async writeBootstrap() { bootstraps++; },
  });
  await assert.rejects(adapter.open({ binding }), { code: 'DESKTOP_NATIVE_INVALID_CHANNEL' });
  assert.equal(bootstraps, 0); assert.equal(closes, 1);
});

// Wire oracle는 설계 §11의 고정 숫자다. 실제 FreeRDP/Windows 소비를 모사하지 않는다.
function nativeFixture({ rejectInput = false, closedReceipt = true, cleanupComplete = true } = {}) {
  const rfbWrites = [], nativeFrames = [], order = [], stderr = new PassThrough();
  let finishExit, sessionRef;
  const exitPromise = new Promise(resolve => { finishExit = resolve; });
  const wire = (kind, sequence, body) => {
    const header = Buffer.alloc(20); header.write('AGNI'); header[4] = 1; header[5] = kind;
    header.writeUInt32BE(body.length, 8); header.writeBigUInt64BE(sequence, 12);
    return Buffer.concat([header, body]);
  };
  const hello = Buffer.alloc(88);
  hello.writeUInt32BE(31); hello.writeUInt32BE(9856, 4); hello.writeUInt16BE(128, 8); hello.writeUInt16BE(256, 10);
  hello.writeUInt32BE(2048, 12); hello.writeUInt32BE(4096, 16); hello.writeUInt32BE(9344, 20); hello[24] = 1;
  hello.writeUInt16BE(3, 28); hello.writeUInt16BE(32, 30); hello.writeUInt16BE(1, 32);
  Buffer.from('bf217a504e54cc719880c228e82353382cd7d4fa', 'hex').copy(hello, 36);
  Buffer.from(rdpApplication.patchDigest, 'hex').copy(hello, 56);
  const inputStream = new Duplex({ read() {}, write(bytes, encoding, callback) {
    const frame = Buffer.from(bytes); nativeFrames.push(frame); order.push('native-' + frame[5]);
    const body = frame.subarray(20), ack = Buffer.alloc(24);
    ack[1] = 1; ack.writeUInt32BE(0xffffffff, 12); ack[16] = 6;
    if (frame[5] === 4) ack[17] = 6;
    else if (body[0] === 4) ack[17] = 2;
    else if (rejectInput) {
      ack[0] = 2; ack.writeUInt16BE(13, 2); ack.writeUInt32BE(1, 8); ack[16] = 1; ack[17] = 1;
    }
    this.push(wire(3, frame.readBigUInt64BE(12), ack)); callback();
  } });
  inputStream.push(wire(1, 0n, hello));
  let rfbStarted = false;
  const stream = new Duplex({ read() {
    if (rfbStarted) return; rfbStarted = true;
    const init = Buffer.alloc(24); init.writeUInt16BE(800); init.writeUInt16BE(600, 2);
    this.push(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1, 0, 0, 0, 0]), init]));
  }, write(bytes, encoding, callback) { rfbWrites.push(Buffer.from(bytes)); callback(); }, final(callback) {
    order.push('rfb-eof');
    if (closedReceipt) stderr.write(JSON.stringify({ agsDesktop: 1, event: 'closed', sessionRef, sessionState: 'terminated' }) + '\n');
    finishExit({ exitCode: 0, remoteState: 'exited', cleanupComplete }); this.push(null); callback();
  } });
  const write = stream.write.bind(stream);
  stream.write = (bytes, ...args) => {
    if (stream.writableEnded) order.push('rfb-write-after-eof');
    return write(bytes, ...args);
  };
  const adapter = createLinuxSessionDesktopAdapter({ width: 800, height: 600, application: rdpApplication,
    async openSession({ command, nativeInput }) {
      assert.equal(nativeInput, true); sessionRef = /--session-ref ([a-f0-9]{48})/.exec(command)[1];
      assert.ok(Buffer.byteLength(command) <= 32768);
      setImmediate(() => stderr.write(JSON.stringify({ agsDesktop: 1, event: 'ready', sessionRef,
        resourceGeneration: 'd'.repeat(64), width: 800, height: 600 }) + '\n'));
      return { stream, inputStream, stderr, exitPromise, async close() { order.push('helper-close'); } };
    }, async writeBootstrap(writable) { assert.equal(writable, stream); order.push('bootstrap'); },
  });
  return { adapter, rfbWrites, nativeFrames, order, inputStream };
}

test('RDP text·key·pointer·release는 native 단일 큐만 쓰며 CLOSE ACK 뒤 helper를 닫는다', async () => {
  const f = nativeFixture(), desktop = await f.adapter.open({ binding });
  assert.equal(desktop.readState().inputVerified, false);
  await desktop.input([{ type: 'text', text: 'A' }]);
  assert.equal(f.nativeFrames[0].toString('hex'), '41474e4901020000000000090000000000000001010000000000000141');
  await desktop.input([{ type: 'key', keysym: 0xffeb, down: true }, { type: 'pointer', x: 20, y: 30, buttons: 1 }]);
  await desktop.release();
  assert.equal(f.nativeFrames[2].toString('hex'), '41474e4901020000000000090000000000000003040000000000000101');
  const receipt = await desktop.close();
  assert.deepEqual(receipt, { sessionState: 'terminated', nativeInputState: 'detached', nativeReleaseSent: true, logout: false });
  assert.deepEqual(await desktop.close(), receipt);
  assert.equal(f.nativeFrames[3].toString('hex'), '41474e490104000000000001000000000000000401');
  assert.ok(f.order.indexOf('native-4') < f.order.indexOf('rfb-eof'));
  assert.equal(f.rfbWrites.filter(bytes => bytes[0] === 4 || bytes[0] === 5).length, 0);
});

test('RDP partial native ACK는 재전송 없이 원 오류와 별도 helper cleanup을 남긴다', async () => {
  const f = nativeFixture({ rejectInput: true }), desktop = await f.adapter.open({ binding });
  await assert.rejects(desktop.input([{ type: 'text', text: 'A' }]), error =>
    error.code === 'DESKTOP_NATIVE_PARTIAL_OR_UNKNOWN' && error.nativeInput.callsAttempted === 1);
  const receipt = await desktop.close();
  assert.deepEqual(receipt, { sessionState: 'terminated', nativeInputState: 'unknown', nativeReleaseSent: false, logout: false });
  assert.deepEqual(await desktop.close(), receipt);
  assert.equal(f.nativeFrames.length, 1); assert.equal(desktop.closed, true);
  assert.equal(f.order.filter(event => event === 'rfb-eof').length, 1);
  assert.equal(f.order.filter(event => event === 'helper-close').length, 1);
  assert.equal(f.order.includes('rfb-write-after-eof'), false);
});

test('RDP partial native ACK 뒤 helper cleanup 증거가 없으면 close도 unknown을 유지한다', async () => {
  for (const config of [{ closedReceipt: false }, { cleanupComplete: false }]) {
    const f = nativeFixture({ ...config, rejectInput: true }), desktop = await f.adapter.open({ binding });
    await assert.rejects(desktop.input([{ type: 'text', text: 'A' }]), error =>
      error.code === 'DESKTOP_NATIVE_PARTIAL_OR_UNKNOWN' && error.nativeInput.callsAttempted === 1);
    const receipt = await desktop.close();
    assert.deepEqual(receipt, { sessionState: 'unknown', nativeInputState: 'unknown', nativeReleaseSent: false, logout: false });
    assert.deepEqual(await desktop.close(), receipt);
    assert.equal(f.nativeFrames.length, 1); assert.equal(f.order.includes('rfb-write-after-eof'), false);
    assert.equal(f.order.filter(event => event === 'helper-close').length, 1);
  }
});

test('RDP native CLOSE ACK는 helper 종료 영수증·cleanup 증거를 대신하지 않는다', async () => {
  for (const config of [{ closedReceipt: false }, { cleanupComplete: false }]) {
    const f = nativeFixture(config), desktop = await f.adapter.open({ binding });
    assert.deepEqual(await desktop.close(), { sessionState: 'unknown', nativeInputState: 'detached', nativeReleaseSent: true, logout: false });
  }
});

test('RDP 취소는 추가 INPUT/CLOSE 재전송 없이 helper를 회수한다', async () => {
  const f = nativeFixture(), controller = new AbortController();
  const desktop = await f.adapter.open({ binding, signal: controller.signal }); controller.abort();
  const receipt = await desktop.close();
  assert.equal(receipt.nativeInputState, 'unknown'); assert.equal(receipt.nativeReleaseSent, false);
  assert.equal(f.nativeFrames.length, 0); assert.ok(f.order.includes('helper-close'));
});

test('TEST Linux GUI: 실제 화면·텍스트·포인터 입력과 소유 세션 종료', integration, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ags-gui-input-proof-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const f = fixture(), desktop = await f.adapter.open({ binding });
  t.after(() => desktop.close());
  const state = desktop.readState(), first = await desktop.observe();
  assert.equal(desktop.lifecycle, 'managed');
  assert.deepEqual(desktop.capabilities, { observe: true, pointer: true, key: true, text: true });
  assert.equal(state.state, 'desktop_ready'); assert.equal(state.osSessionId, null);
  assert.match(state.sessionRef, /^[a-f0-9]{48}$/); assert.match(state.resourceGeneration, /^[a-f0-9]{64}$/);
  assert.equal(first.width, 800); assert.equal(first.height, 600);
  assert.equal(first.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await desktop.input([{ type: 'pointer', x: 180, y: 130, buttons: 1 }, { type: 'pointer', x: 180, y: 130, buttons: 0 }]);
  const output = join(folder, 'keyboard-proof');
  await desktop.input([{ type: 'text', text: `printf AGS_GUI_OK > ${output}` },
    { type: 'key', keysym: 0xff0d, down: true }, { type: 'key', keysym: 0xff0d, down: false }]);
  await eventually(async () => await exists(output) && await readFile(output, 'utf8') === 'AGS_GUI_OK');
  const next = await desktop.observe(); assert.notEqual(hash(first.data), hash(next.data));
  assert.deepEqual(await desktop.close(), { sessionState: 'terminated' });
  assert.deepEqual(await desktop.close(), { sessionState: 'terminated' });
  await assertGone(f.channels[0]);
  console.log(JSON.stringify({ case: 'gui-input-close', ready: ready(f.channels[0]), closed: f.channels[0].events.find(event => event.event === 'closed') }));
});

test('TEST Linux GUI: 동시 세션은 display·generation·PID를 공유하지 않는다', integration, async t => {
  const f = fixture();
  const desktops = await Promise.all([f.adapter.open({ binding }), f.adapter.open({ binding: { ...binding, epoch: 2 } })]);
  t.after(() => Promise.all(desktops.map(desktop => desktop.close())));
  assert.notEqual(ready(f.channels[0]).display, ready(f.channels[1]).display);
  assert.notEqual(desktops[0].readState().resourceGeneration, desktops[1].readState().resourceGeneration);
  assert.equal(new Set(f.channels.flatMap(channel => ready(channel).pids)).size, 6);
  await Promise.all(desktops.map(desktop => desktop.observe()));
  await Promise.all(desktops.map(desktop => desktop.close()));
  await Promise.all(f.channels.map(assertGone));
});

test('TEST Linux GUI: RFB 입력 EOF와 TTL이 소유 자식을 회수한다', integration, async () => {
  for (const ttlMs of [30000, 1500]) {
    const f = fixture({ ttlMs }), desktop = await f.adapter.open({ binding });
    if (ttlMs === 30000) f.channels[0].stream.end();
    const exit = await f.channels[0].exitPromise; assert.equal(exit.exitCode, 0);
    await assertGone(f.channels[0]);
    const closed = f.channels[0].events.find(event => event.event === 'closed');
    assert.equal(closed.sessionState, 'terminated');
    assert.equal(closed.reason, ttlMs === 30000 ? 'input_eof' : 'ttl');
    await desktop.close();
  }
});

test('TEST Linux GUI: helper 종료 영수증이 없으면 성공한 exit도 unknown이다', integration, async () => {
  const f = fixture({ dropClosedReceipt: true }), desktop = await f.adapter.open({ binding });
  assert.deepEqual(await desktop.close(), { sessionState: 'unknown' });
  await assertGone(f.channels[0]);
});

test('TEST Linux GUI: 터미널이 만든 별도 프로세스 세션도 함께 회수한다', integration, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'ags-gui-descendant-proof-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const f = fixture(), desktop = await f.adapter.open({ binding });
  let descendant;
  t.after(async () => {
    await desktop.close();
    if (descendant && await exists('/proc/' + descendant)) {
      // 이 시험에서 직접 만든 sleep만 정리한다. 회귀 실패도 서버에 남기지 않는다.
      const command = await readFile(`/proc/${descendant}/cmdline`, 'utf8');
      if (command === '/bin/sleep\u000060\u0000') process.kill(descendant, 'SIGKILL');
    }
  });
  const path = join(folder, 'pid');
  // setsid 자체가 fork할 수 있으므로 $! 대신 새 session 안의 실제 exec PID를 기록한다.
  await desktop.input([{ type: 'text', text: `/usr/bin/setsid /bin/sh -c 'printf "%s" $$ > ${path}; exec /bin/sleep 60' </dev/null >/dev/null 2>&1 &` },
    { type: 'key', keysym: 0xff0d, down: true }, { type: 'key', keysym: 0xff0d, down: false }]);
  await eventually(() => exists(path));
  descendant = Number(await readFile(path, 'utf8'));
  assert.ok(Number.isSafeInteger(descendant) && descendant > 1);
  await eventually(async () => await exists('/proc/' + descendant)
    && await readFile(`/proc/${descendant}/cmdline`, 'utf8') === '/bin/sleep\u000060\u0000');
  await desktop.close();
  await eventually(async () => !await exists('/proc/' + descendant), 2000);
  console.log(JSON.stringify({ case: 'descendant-cleanup', descendant, gone: true }));
});
