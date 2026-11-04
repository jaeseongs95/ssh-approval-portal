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
  const application = { kind: 'rdp', host: '127.0.0.1', port: 3389, executable: '/usr/bin/xfreerdp',
    width: 800, height: 600, certificateMode: 'ssh-tunnel' };
  const config = { openSession() {}, width: 800, height: 600, application, writeBootstrap() {} };
  assert.doesNotThrow(() => createLinuxSessionDesktopAdapter(config));
  for (const change of [{ host: 'example.com' }, { executable: '/tmp/client' }, { port: 0 },
    { certificateMode: 'ignore' }, { width: 900 }, { command: '/bin/sh' }, { password: 'forbidden' }]) {
    assert.throws(() => createLinuxSessionDesktopAdapter({ ...config, application: { ...application, ...change } }),
      error => error.code === 'DESKTOP_INVALID_CONFIG');
  }
  assert.throws(() => createLinuxSessionDesktopAdapter({ ...config, writeBootstrap: undefined }),
    error => error.code === 'DESKTOP_INVALID_CONFIG');
});

test('RDP bootstrap 실패는 RFB 전에 원 오류를 보존하고 채널을 닫는다', async () => {
  const stream = new PassThrough(), failure = Error('credential-provider-failed');
  let calls = 0, closes = 0, command;
  const adapter = createLinuxSessionDesktopAdapter({ width: 800, height: 600,
    application: { kind: 'rdp', host: '127.0.0.1', port: 3389, executable: '/usr/bin/xfreerdp3',
      width: 800, height: 600, certificateMode: 'ssh-tunnel' },
    async openSession(options) { command = options.command; return { stream, stderr: new PassThrough(),
      exitPromise: Promise.resolve({ exitCode: 1, remoteState: 'exited' }), async close() { closes++; } }; },
    async writeBootstrap(writable) { assert.equal(writable, stream); calls++; throw failure; },
  });
  await assert.rejects(adapter.open({ binding }), error => error === failure);
  assert.equal(calls, 1); assert.equal(closes, 1);
  assert.ok(Buffer.byteLength(command) <= 32768); assert.ok(!command.includes(failure.message));
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
