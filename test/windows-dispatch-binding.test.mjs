import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';
import { createApplication } from '../app.mjs';
import { createSshRuntime } from '../src/adapters/ssh/vendor.mjs';
import { presentJob } from '../src/adapters/presentation/results.mjs';

// 실제 앱·소유 SSH 실행 supervisor·SftpClient·전송 guard를 사용한다.
// 네트워크만 결정적 대기로 대체하며 콜백을 무시하는 별도 executor는 쓰지 않는다.
const bytes = Buffer.from([0, 255, 13, 10]);
const sha = value => createHash('sha256').update(value).digest('hex');
const entry = { id: 'windows', displayName: '합성 Windows', platform: 'windows', readProfile: 'win-read', writeProfile: 'win-write', credentialRevision: 'v1' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { testServer = false, automation = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-binding-'));
  const config = join(root, 'profiles.toml');
  await writeFile(config, '[defaults]\ndefaultProfile="win-write"\ncommandTimeoutMs=3000\n' + ['read', 'write'].map(mode => `
[[profiles]]
name="win-${mode}"
host="127.0.0.1"
port=22
user="synthetic"
auth="key"
keyRef="/synthetic-unused-key"
trustedHostKey="SHA256:synthetic"
readOnly=${mode === 'read'}
tty=false
announceAgent=false
transferTimeoutMs=3000
`).join(''), { encoding: 'utf8', mode: 0o600 });
  const runtime = await createSshRuntime({ BRIDGE_CONFIG_PATH: config, BRIDGE_HOST_KEY_MODE: 'strict' });
  const profiles = new Map(['win-read', 'win-write'].map(name => [name, { ...runtime.registry.getProfile(name) }]));
  const effects = { command: 0, sftp: 0, publish: 0, snapshot: 0, cleanup: 0 };
  const remote = new Map([['C:/approved/input.bin', bytes]]);
  const stages = new Set();
  let barrier, flow, ensureCalls = 0, refused = false, lastChecks = 0, loseReply = false, cleanupReply;
  const enter = async phase => {
    if (barrier?.phase === phase && !barrier.entered) {
      barrier.entered = true; barrier.arrived.resolve(); await barrier.release.promise;
    }
  };
  const connections = new Map();
  for (const [name, profile] of profiles) {
    const connection = new SSHConnection(structuredClone(profile), {}, new Map(), 'strict');
    connection.ensureConnected = async () => {
      ensureCalls++;
      if (!connection.connected) throw Error('Synthetic connection loss');
      await enter(refused ? 'retry' : 'connect');
    };
    connection.client = Object.assign(new EventEmitter(), {
      exec(command, options, callback) {
        if (barrier?.phase === 'retry' && !refused) { refused = true; callback(Object.assign(Error('Synthetic channel refusal'), { reason: 1 })); return; }
        const input = [];
        const stream = new Duplex({ read() {}, write(chunk, encoding, done) { input.push(Buffer.from(chunk)); done(); } });
        stream.stderr = new PassThrough(); stream.signal = () => {}; stream.close = () => stream.destroy();
        callback(null, stream);
        setImmediate(async () => {
          let stdout = 'ok', exitCode = 0;
          if (command.includes('-File ')) {
            const payload = JSON.parse(Buffer.concat(input).toString('utf8'));
            effects[payload.action]++;
            const stage = 'C:/ProgramData/ssh-approval-transfer/incoming/' + payload.id + '.part';
            if (payload.action === 'publish') {
              assert.deepEqual(remote.get(stage), bytes); remote.set(payload.remotePath, remote.get(stage));
              stdout = JSON.stringify({ published: true });
            } else if (payload.action === 'snapshot') {
              const body = remote.get(payload.remotePath); remote.set(stage, body);
              stages.add(stage); await enter('staged-download');
              stdout = JSON.stringify({ size: body.length, sha256: sha(body) });
            } else {
              assert.equal(payload.action, 'cleanup');
              if (cleanupReply) { stdout = JSON.stringify(cleanupReply.data); exitCode = cleanupReply.exitCode; }
              else { remote.delete(stage); stdout = JSON.stringify({ cleaned: true }); }
            }
          } else effects.command++;
          if (loseReply) { stream.push(null); stream.emit('close', undefined); return; }
          stream.push(Buffer.from(stdout)); stream.push(null); stream.emit('exit', exitCode); stream.emit('close', exitCode);
        });
      },
      sftp(callback) {
        if (barrier?.phase === 'retry' && !refused) { refused = true; callback(Object.assign(Error('Synthetic channel refusal'), { reason: 1 })); return; }
        effects.sftp++;
        callback(null, {
          stat(path, done) { const body = remote.get(path); done(body ? null : Object.assign(Error('Missing fixture'), { code: 2 }), body && { size: body.length, mode: 0o100600 }); },
          createWriteStream(path) { const chunks = []; return new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) { remote.set(path, Buffer.concat(chunks)); done(); } }); },
          createReadStream(path) { return Readable.from([remote.get(path)]); },
          ext_openssh_hardlink(from, to, done) { remote.set(to, remote.get(from)); stages.add(to); void enter('staged-upload').then(() => done()); },
          unlink(path, done) { remote.delete(path); done(); },
          end() {},
        });
      },
    });
    connection.connected = true;
    connection.getClient = () => { if (!connection.client) throw Error('Synthetic connection loss'); return connection.client; };
    connections.set(name, connection);
  }
  runtime.registry.getProfile = name => profiles.get(name);
  runtime.registry.getOrCreate = async name => { await enter('registry'); return connections.get(name); };
  runtime.registry.closeAll = async () => {};
  const resolver = { resolve: async () => { await enter('secret'); return '1'.repeat(64); } };
  const app = await createApplication({ ...runtime, registry: runtime.registry, transferRoot: root,
    classify: () => ({ class: 'safe' }), audit() {}, uiHtml: '<html></html>', secretResolver: resolver,
    env: { BRIDGE_MCP_TOKEN: 'synthetic-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-owner', BRIDGE_ADMIN_ORIGIN: 'https://owner.test', BRIDGE_UI_TICKET_KEY: 'f'.repeat(64),
      BRIDGE_TARGETS: JSON.stringify([entry]), BRIDGE_DEFAULT_TARGET: 'windows', BRIDGE_COMMAND_AUTOMATION: String(automation), BRIDGE_TEST_SERVER_SECRET_REF: 'secret://fixture/test-server' } });
  t.after(async () => { barrier?.release.resolve(); await app.close(); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const target = app.targets.select('windows');
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.adminHttp.address().port}` + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer synthetic-owner', ...(body === undefined ? {} : { Origin: 'https://owner.test', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  let rule;
  const policy = async patch => {
    const current = await api('/api/command-policy');
    rule = { targetId: target.id, targetRevision: target.revision, profile: target.writeProfile, platform: 'windows', commands: ['whoami.exe'], deniedCommands: [],
      automaticUploads: true, automaticDownloads: true, externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {}, testServer, ...patch };
    const proposal = { expectedRevision: current.revision, policy: { targets: [rule] } };
    const review = await api('/api/command-policy/review', proposal);
    await api('/api/command-policy', { ...proposal, reviewToken: review.reviewToken, acknowledged: true });
  };
  if (automation) await policy();
  // 마지막 await 이후 변경을 큐 hook의 동기 관측에서 microtask로 주입한다.
  // 소유 exec supervisor와 SFTP 모두 ensureConnected 뒤 getClient를 쓴다.
  for (const key of ['beforeCommandStart', 'beforeUploadStart', 'beforeDownloadStart']) {
    const original = target.queue[key];
    if (!original) continue;
    target.queue[key] = job => {
      const result = original(job);
      if (barrier?.phase === 'last' && ensureCalls >= 1 && ++lastChecks === 2) {
        queueMicrotask(() => { barrier.change(); barrier.arrived.resolve(); });
      }
      return result;
    };
  }
  return { app, target, effects, remote, profiles, connections, policy, stages,
    arm(phase, change) { ensureCalls = 0; refused = false; lastChecks = 0; barrier = { phase, change, arrived: deferred(), release: deferred() }; return barrier; },
    async submit(kind) {
      flow = kind;
      if (kind === 'owner' || kind === 'names') {
        const result = await app.targets.commands.run(kind === 'owner' ? 'unlisted.exe' : 'whoami.exe', 'windows');
        if (kind === 'owner') app.queue.start(result.job.id);
        return result.job.id;
      }
      const binding = { target: 'windows', expectedTargetRevision: target.revision };
      if (kind === 'download') return app.targets.files.requestDownload({ ...binding, remotePath: 'C:/approved/input.bin' }).id;
      const item = await app.targets.files.beginUpload({ ...binding, fileName: 'output.bin', remotePath: 'C:/approved/output.bin', size: bytes.length, sha256: sha(bytes), overwrite: false, elevate: false });
      await app.targets.files.appendUpload({ id: item.id, sequence: 0, bytes });
      return (await app.targets.files.finishUpload(item.id)).id;
    },
    resetEffects() { for (const key of Object.keys(effects)) effects[key] = 0; },
    loseReply() { loseReply = true; },
    failCleanup(mode) { cleanupReply = mode === 'refused' ? { exitCode: 1, data: { errorCode: 'OPERATION_FAILED' } } : { exitCode: 0, data: {} }; },
  };
}

test('DISPATCH-BIND 비TEST 연결 대기 중 변경은 실제 exec/SFTP/helper 효과를 차단한다', { timeout: 120000 }, async t => {
  for (const flow of ['owner', 'names', 'upload', 'download']) for (const phase of (flow === 'upload' ? ['registry', 'connect', 'retry'] : ['registry', 'connect'])) {
    await t.test(flow + '/' + phase, async t => {
      const f = await fixture(t);
      for (const change of ['target', 'connection-profile', 'policy', 'permission', 'expiry', 'maintenance']) {
        f.resetEffects(); const gate = f.arm(phase);
        const id = await f.submit(flow); await gate.arrived.promise;
        const configured = structuredClone(f.profiles.get('win-write'));
        const connection = f.connections.get(flow === 'download' ? 'win-read' : 'win-write');
        const connected = structuredClone(connection.profile), now = f.target.queue.now;
        if (change === 'target') f.profiles.get('win-write').host = 'changed.example.test';
        if (change === 'connection-profile') connection.profile.user = 'changed-user';
        if (change === 'policy') await f.policy();
        if (change === 'permission') await f.policy(flow === 'upload' ? { automaticUploads: false } : flow === 'download' ? { automaticDownloads: false } : { deniedCommands: [flow === 'owner' ? 'unlisted.exe' : 'whoami.exe'] });
        if (change === 'expiry') { const deadline = f.target.queue.get(id).expiresAt; f.target.queue.now = () => deadline; }
        if (change === 'maintenance') f.target.queue.maintenance = true;
        gate.release.resolve();
        const result = await f.app.queue.wait(id);
        assert.equal(result.state, 'failed', change + ': ' + JSON.stringify(result.result));
        assert.deepEqual(f.effects, { command: 0, sftp: 0, publish: 0, snapshot: 0, cleanup: 0 }, change);
        assert.equal(f.remote.has('C:/approved/output.bin'), false);
        assert.throws(() => f.app.queue.start(id));
        f.profiles.set('win-write', configured); connection.profile = connected; f.target.queue.now = now; f.target.queue.maintenance = false;
        await f.policy();
      }
      f.resetEffects(); f.arm('none'); const id = await f.submit(flow), completed = await f.app.queue.wait(id);
      assert.equal(completed.state, 'completed');
      if (flow === 'owner' || flow === 'names') { assert.equal(f.effects.command, 1); assert.equal(completed.result.output.state, 'ready'); }
      else { assert.equal(f.effects.sftp, 1); assert.equal(f.effects[flow === 'upload' ? 'publish' : 'snapshot'], 1); }
    });
  }
});

test('DISPATCH-BIND 마지막 await 뒤의 대상·만료·유지보수 변경도 getClient 전에 거부한다', { timeout: 30000 }, async t => {
  for (const flow of ['owner', 'names', 'upload', 'download']) for (const change of ['target', 'expiry', 'maintenance']) await t.test(flow + '/' + change, async t => {
    const f = await fixture(t);
    const gate = f.arm('last', () => {
      if (change === 'target') f.profiles.get('win-write').host = 'changed.example.test';
      if (change === 'expiry') { const deadline = f.target.queue.active.expiresAt; f.target.queue.now = () => deadline; }
      if (change === 'maintenance') f.target.queue.maintenance = true;
    });
    const id = await f.submit(flow); await gate.arrived.promise;
    assert.equal((await f.app.queue.wait(id)).state, 'failed');
    assert.deepEqual(f.effects, { command: 0, sftp: 0, publish: 0, snapshot: 0, cleanup: 0 });
    f.target.queue.maintenance = false;
  });
});

test('DISPATCH-BIND TEST 비밀 확인의 await 도중 정책·대상 변경도 미실행한다', async t => {
  for (const change of ['target', 'policy']) await t.test(change, async t => {
    const f = await fixture(t, { testServer: true }); const gate = f.arm('secret');
    const id = await f.submit('names'); await gate.arrived.promise;
    if (change === 'target') f.profiles.get('win-write').host = 'changed.example.test';
    else { gate.entered = true; await f.policy(); }
    gate.release.resolve(); await f.app.queue.wait(id);
    assert.deepEqual(f.effects, { command: 0, sftp: 0, publish: 0, snapshot: 0, cleanup: 0 });
  });
});

test('DISPATCH-BIND 큐 없는 읽기와 기존 수동 파일 승인은 유지한다', async t => {
  const f = await fixture(t, { automation: false });
  const read = await f.app.targets.commands.read('Microsoft.PowerShell.Utility\\Get-Date', 'windows');
  assert.equal(read.failed, false); assert.equal(f.effects.command, 1);
  for (const kind of ['upload', 'download']) {
    const id = await f.submit(kind); assert.equal(f.app.queue.get(id).state, 'pending');
    f.app.queue.start(id); assert.equal((await f.app.queue.wait(id)).state, 'completed');
    assert.equal(f.effects[kind === 'upload' ? 'publish' : 'snapshot'], 1);
  }
});

test('DISPATCH-BIND 원격 효과 뒤 응답 유실은 자동 재실행하지 않는다', async t => {
  const f = await fixture(t); f.loseReply(); const id = await f.submit('names');
  const result = await f.app.queue.wait(id);
  assert.equal(result.state, 'unknown');
  assert.equal(result.result.execution.reason, 'transport_lost');
  assert.equal(result.result.execution.remoteState, 'unknown');
  assert.equal(result.result.execution.automaticReplay, false);
  assert.equal(f.effects.command, 1); assert.throws(() => f.app.queue.start(id)); assert.equal(f.effects.command, 1);
});

test('DISPATCH-CLEANUP 부분 전송 뒤 승인 철회는 게시·수신을 막고 자기 part만 정리한다', { timeout: 30000 }, async t => {
  for (const flow of ['upload', 'download']) for (const change of ['policy', 'expiry', 'maintenance']) await t.test(flow + '/' + change, async t => {
    const f = await fixture(t), foreign = 'C:/ProgramData/ssh-approval-transfer/incoming/' + 'f'.repeat(48) + '.part';
    const foreignBytes = Buffer.from('다른 작업의 임시자료'); f.remote.set(foreign, foreignBytes);
    const gate = f.arm('staged-' + flow), id = await f.submit(flow);
    await gate.arrived.promise;
    const [ownStage] = [...f.stages]; assert.equal(f.stages.size, 1); assert.deepEqual(f.remote.get(ownStage), bytes);
    if (change === 'policy') await f.policy();
    if (change === 'expiry') { const deadline = f.target.queue.get(id).expiresAt; f.target.queue.now = () => deadline; }
    if (change === 'maintenance') f.target.queue.maintenance = true;
    gate.release.resolve();
    const result = await f.app.queue.wait(id);
    assert.equal(result.state, 'failed'); assert.equal(f.effects.publish, 0);
    assert.equal(result.result.execution.reason, 'input_failed'); assert.equal(result.result.execution.remoteState, 'exited');
    assert.equal(result.result.execution.exitCode, 1); assert.equal(result.result.execution.cleanupComplete, true);
    assert.equal(result.result.execution.requiresReconciliation, false); assert.equal(result.result.data.remoteCleanup, 'confirmed');
    assert.equal(f.effects.sftp, flow === 'upload' ? 1 : 0);
    assert.equal(f.effects.snapshot, flow === 'download' ? 1 : 0);
    assert.equal(f.effects.cleanup, 1); assert.equal(f.remote.has(ownStage), false);
    assert.deepEqual(f.remote.get(foreign), foreignBytes); assert.deepEqual(f.remote.get('C:/approved/input.bin'), bytes);
    assert.equal(f.remote.has('C:/approved/output.bin'), false); assert.throws(() => f.app.queue.start(id));
    f.target.queue.maintenance = false;
  });
});

test('DISPATCH-CLEANUP 원래 대상·연결이 달라지면 삭제하지 않고 잔존 확인 필요를 남긴다', { timeout: 30000 }, async t => {
  for (const flow of ['upload', 'download']) for (const change of ['target', 'connection-profile', 'host-key', 'disconnect', 'replaced-client']) await t.test(flow + '/' + change, async t => {
    const f = await fixture(t), foreign = 'C:/ProgramData/ssh-approval-transfer/incoming/' + 'e'.repeat(48) + '.part';
    const foreignBytes = Buffer.from('보존할 다른 임시자료'); f.remote.set(foreign, foreignBytes);
    const gate = f.arm('staged-' + flow), id = await f.submit(flow); await gate.arrived.promise;
    const [ownStage] = [...f.stages]; assert.equal(f.stages.size, 1);
    // 새 publish/수신 권한은 철회하고 정리의 연결 결속만 독립 대조한다.
    await f.policy();
    const connection = f.connections.get(flow === 'download' ? 'win-read' : 'win-write');
    if (change === 'target') f.profiles.get('win-write').host = 'changed.example.test';
    if (change === 'connection-profile') connection.profile.user = 'changed-user';
    if (change === 'host-key') f.profiles.get('win-write').trustedHostKey = 'SHA256:changed';
    if (change === 'disconnect') { connection.connected = false; connection.client = null; }
    if (change === 'replaced-client') connection.client = { ...connection.client };
    gate.release.resolve();
    const result = await f.app.queue.wait(id);
    assert.equal(result.state, 'unknown'); assert.equal(result.result.data.remoteCleanup, 'unconfirmed');
    assert.equal(result.result.execution.remoteState, 'unknown'); assert.equal(result.result.execution.cleanupComplete, false);
    assert.equal(result.result.execution.requiresReconciliation, true); assert.equal(result.result.execution.automaticReplay, false);
    const transferId = ownStage.split('/').at(-1).slice(0, -5);
    assert.equal(result.result.data.transferId, transferId);
    const presented = presentJob(result);
    assert.equal(presented.targetId, 'windows'); assert.equal(presented.result.structuredContent.transferId, transferId);
    assert.match(result.result.texts[0], /원래 대상.*확인/);
    assert.equal(f.effects.publish, 0); assert.equal(f.effects.sftp, flow === 'upload' ? 1 : 0); assert.equal(f.effects.cleanup, 0);
    assert.deepEqual(f.remote.get(ownStage), bytes); assert.deepEqual(f.remote.get(foreign), foreignBytes);
    assert.deepEqual(f.remote.get('C:/approved/input.bin'), bytes); assert.equal(f.remote.has('C:/approved/output.bin'), false);
    assert.throws(() => f.app.queue.start(id));
  });
});

test('DISPATCH-CLEANUP 본 작업 뒤 정리 응답이 거부·불완전이면 성공을 단정하지 않는다', async t => {
  for (const flow of ['upload', 'download']) for (const mode of ['refused', 'missing-confirmation']) await t.test(flow + '/' + mode, async t => {
    const f = await fixture(t); f.failCleanup(mode); const id = await f.submit(flow);
    const result = await f.app.queue.wait(id), [ownStage] = [...f.stages];
    assert.equal(result.state, 'unknown'); assert.equal(result.result.data.remoteCleanup, 'unconfirmed');
    assert.equal(result.result.execution.remoteState, 'unknown'); assert.equal(result.result.execution.cleanupComplete, false);
    assert.equal(result.result.execution.requiresReconciliation, true); assert.equal(result.result.execution.automaticReplay, false);
    assert.equal(presentJob(result).result.structuredContent.transferId, ownStage.split('/').at(-1).slice(0, -5));
    assert.match(result.result.texts[0], /이미 반영됐거나.*남아 있을 수/);
    assert.equal(f.effects[flow === 'upload' ? 'publish' : 'snapshot'], 1); assert.equal(f.effects.sftp, 1);
    assert.equal(f.effects.cleanup, 1); assert.deepEqual(f.remote.get(ownStage), bytes);
    if (flow === 'upload') assert.deepEqual(f.remote.get('C:/approved/output.bin'), bytes);
    assert.throws(() => f.app.queue.start(id));
  });
});

test('DISPATCH-CLEANUP 파일 헬퍼 효과 뒤 응답 유실은 정리 효과가 있어도 unknown을 보존한다', async t => {
  for (const flow of ['upload', 'download']) await t.test(flow, async t => {
    const f = await fixture(t); f.loseReply(); const id = await f.submit(flow);
    const result = await f.app.queue.wait(id);
    assert.equal(result.state, 'unknown'); assert.equal(result.result.execution.remoteState, 'unknown');
    assert.equal(result.result.execution.requiresReconciliation, true); assert.equal(result.result.execution.automaticReplay, false);
    assert.equal(f.effects[flow === 'upload' ? 'publish' : 'snapshot'], 1); assert.equal(f.effects.cleanup, 1);
    assert.equal(f.effects.sftp, flow === 'upload' ? 1 : 0);
    assert.equal(f.remote.has('C:/approved/output.bin'), flow === 'upload');
    assert.deepEqual(f.remote.get('C:/approved/input.bin'), bytes);
    assert.throws(() => f.app.queue.start(id));
    assert.equal(f.effects[flow === 'upload' ? 'publish' : 'snapshot'], 1);
  });
});
