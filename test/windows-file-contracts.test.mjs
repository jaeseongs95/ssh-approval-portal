import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { remotePath, windowsRemotePath, anyRemotePath, remoteBasename, hash } from '../src/domain/validation.mjs';
import { createFileService } from '../src/application/files.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { Transfers } from '../src/adapters/ssh/transfers.mjs';
import { validateDownloadExpectation } from '../src/adapters/cli/portal-client.mjs';
import { validateFileManifest } from '../src/adapters/cli/file-forwarder.mjs';

// 시험 계획: 공개 경계에서 경로 문법, 대상별 거절 시점, 고정 실행 명령과
// 바이너리·결속·정리 동작을 검사한다. 실제 SSH·설치 권한은 별도 통합 시험 범위다.
const bytes = Buffer.from([0, 255, 13, 10, 128]);
const path = 'C:\\승인 파일\\한글.bin';
const revision = 'b'.repeat(64);
const metadata = (remotePath = path) => ({ fileName: '한글.bin', remotePath, size: bytes.length, sha256: hash(bytes), overwrite: false, elevate: false });

test('Windows 경로는 두 구분자를 허용하고 위험한 경로를 거부한다', () => {
  for (const value of [path, 'd:/승인 파일/한글.bin', "C:/files/single'quote.bin"]) {
    assert.equal(windowsRemotePath(value), value);
    assert.equal(anyRemotePath(value), value);
  }
  for (const value of [undefined, '', 'C:', 'C:relative.bin', 'C:/', '/tmp/file', '\\\\server\\share\\file', '//server/share/file',
    '\\\\?\\C:\\file', '\\\\.\\NUL', 'C:/file:stream', 'C:/dir/../file', 'C:/dir/./file', 'C:/dir//file',
    'C:/dir\\\\file', 'C:/file/', 'C:/dir./file', 'C:/dir /file', 'C:/file.', 'C:/file ', 'C:/fi\nle', 'C:/fi\u200ble',
    'C:/file?.bin', 'C:/file*.bin', 'C:/file".bin', 'C:/file<.bin', 'C:/file|.bin', 'C:/CON', 'C:/nul.txt',
    'C:/AUX/file', 'C:/prn', 'C:/COM1.log', 'C:/lpt9', 'C:/COM¹.txt', 'C:/LPT².txt', 'C:/' + 'x'.repeat(4094)]) {
    assert.throws(() => windowsRemotePath(value), undefined, String(value));
  }
  assert.equal(remoteBasename(path, 'windows'), '한글.bin');
  assert.equal(remoteBasename('C:/files/file.bin', 'windows'), 'file.bin');
  assert.throws(() => remoteBasename(path, 'unknown'));
});

test('기존 POSIX 경로 문법과 기본 basename 동작을 보존한다', () => {
  for (const value of ['/tmp/한글.bin', '/tmp/back\\slash.bin']) {
    assert.equal(remotePath(value), value); assert.equal(anyRemotePath(value), value);
  }
  assert.equal(remoteBasename('/tmp/back\\slash.bin'), 'back\\slash.bin');
  assert.equal(remoteBasename('/tmp/directory///'), 'directory');
  assert.equal(remoteBasename('///'), '');
  assert.throws(() => remotePath(path));
  assert.throws(() => anyRemotePath('C:/NUL.txt'));
});

test('클라이언트 기대값과 전달 명세는 Windows 경로와 기존 결속 필드를 수용한다', () => {
  const expected = { size: bytes.length, sha256: hash(bytes), target: 'windows', targetRevision: revision, remotePath: path, elevate: false };
  assert.deepEqual(validateDownloadExpectation(expected), expected);
  const value = { version: 1, origin: 'https://portal.example.com', capabilities: [{ id: 'a'.repeat(48), publicName: '다운로드',
    direction: 'download', target: 'windows', targetRevision: revision, remotePath: path, size: bytes.length,
    sha256: hash(bytes), expiresAt: Date.now() + 60_000, elevate: false, destination: join(tmpdir(), 'download.bin') }] };
  assert.equal(validateFileManifest(value).capabilities[0].remotePath, path);
  assert.throws(() => validateDownloadExpectation({ ...expected, remotePath: 'C:/NUL.txt' }), { code: 'INVALID_DOWNLOAD_EXPECTATION' });
  assert.throws(() => validateFileManifest({ ...value, capabilities: [{ ...value.capabilities[0], remotePath: 'C:/file:stream' }] }), { code: 'INVALID_FILE_MANIFEST' });
});

test('공유 저장소는 두 대상 문법을 받아들이고 메타데이터와 결속을 보존한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-artifacts-'));
  try {
    const store = new Artifacts(root, { maxBytes: 32, budget: 128 }); await store.init();
    for (const remotePath of [path, '/tmp/한글.bin']) {
      const item = await store.begin({ ...metadata(remotePath), targetId: 'windows', targetRevision: revision, fileTargetBound: true });
      await store.append(item.id, 0, bytes);
      const ready = await store.finish(item.id);
      assert.equal(ready.remotePath, remotePath); assert.equal(ready.targetId, 'windows');
      assert.equal(ready.targetRevision, revision); assert.equal(ready.fileTargetBound, true);
      await store.remove(item.id);
    }
    let closed = 0;
    const imported = await store.importFile(metadata(), async () => ({ stream: Readable.from([bytes]), expectedSize: bytes.length, close: () => { closed++; } }));
    assert.equal(closed, 1);
    assert.equal(imported.remotePath, path); assert.equal(imported.sha256, hash(bytes));
    await store.remove(imported.id);
    await assert.rejects(store.begin(metadata('C:/file:stream')));
    assert.equal(store.reserved, 0);
  } finally { await rm(root, { recursive: true }); }
});

test('파일 서비스는 대상 문법과 Windows 승격을 부작용 전에 검사한다', async () => {
  const effects = [];
  const store = { begin: async meta => { effects.push('begin'); return meta; } };
  const queue = { submitOperation: op => { effects.push('submit'); return { id: 'job', operation: op }; },
    startDownload: () => {}, get: () => ({ id: 'job' }) };
  const windows = createFileService({ store, queue, platform: 'windows' });
  const linux = createFileService({ store, queue });
  const source = { inspect: () => { effects.push('inspect'); return { allowed: false }; } };
  for (const [service, remotePath, elevate] of [[windows, path, true], [windows, '/tmp/file', false], [linux, path, false]]) {
    await assert.rejects(service.beginUpload({ ...metadata(remotePath), elevate }));
    await assert.rejects(service.requestUpload({ source, ...metadata(remotePath), elevate }));
    assert.throws(() => service.requestDownload({ remotePath, elevate }));
  }
  assert.deepEqual(effects, []);
  const binding = { targetId: 'windows', targetRevision: revision };
  const begun = await windows.beginUpload(metadata(), binding);
  assert.equal(begun.fileTargetBound, true); assert.equal(begun.targetRevision, revision);
  assert.equal(windows.requestDownload({ remotePath: path, elevate: false }, binding).id, 'job');
  assert.deepEqual(effects, ['begin', 'submit']);
  await windows.close(); await linux.close();
});

test('Windows 전송은 고정 명령과 JSON으로 바이트를 왕복하고 정리한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-transfers-'));
  try {
    const store = new Artifacts(root, { maxBytes: 32, budget: 128 }); await store.init();
    const calls = [], uploaded = [], stagingPaths = [], profiles = [];
    const session = {
      async call(command, payload) {
        calls.push({ command, payload });
        return { exitCode: 0, stdout: JSON.stringify(payload.action === 'snapshot' ? { size: bytes.length, sha256: hash(bytes) } : { ok: true }) };
      },
      async upload(stream, path) { stagingPaths.push(path); for await (const chunk of stream) uploaded.push(chunk); },
      async download(path, destination) { stagingPaths.push(path); destination.end(bytes); },
    };
    const transfers = new Transfers(null, store, { platform: 'windows', readProfile: 'reader', writeProfile: 'writer',
      transport: { connect: async profile => { profiles.push(profile); return session; } } });
    const binding = { targetId: 'windows', targetRevision: revision, fileTargetBound: true };
    const item = await store.begin({ ...metadata(), ...binding });
    await store.append(item.id, 0, bytes); await store.finish(item.id);
    const op = { ...metadata(), artifactId: item.id, fileTargetId: 'windows', fileTargetRevision: revision };
    await assert.rejects(transfers.upload({ ...op, fileTargetRevision: 'c'.repeat(64) }), /frozen/);
    assert.deepEqual(profiles, []);
    assert.equal((await transfers.upload(op)).failed, false);
    assert.deepEqual(Buffer.concat(uploaded), bytes);
    const downloaded = await transfers.download({ remotePath: path, elevate: false, fileTargetId: 'windows', fileTargetRevision: revision });
    assert.equal(downloaded.failed, false); assert.equal(downloaded.data.fileName, '한글.bin');
    const ready = store.get(downloaded.data.artifactId);
    assert.equal(ready.targetId, 'windows'); assert.equal(ready.targetRevision, revision);
    const fd = await store.verified(ready.id);
    const received = Buffer.alloc(bytes.length);
    try { await fd.read(received, 0, received.length, 0); assert.deepEqual(received, bytes); } finally { await fd.close(); }
    assert.deepEqual(profiles, ['writer', 'reader']);
    assert.deepEqual(calls.map(x => x.payload.action), ['publish', 'cleanup', 'snapshot', 'cleanup']);
    for (const { command } of calls) assert.equal(command, 'powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:/ProgramData/ssh-approval-portal/windows-file-helper.ps1"');
    assert.equal(calls[0].payload.remotePath, path); assert.equal(calls[0].payload.sha256, hash(bytes));
    for (const staged of stagingPaths) assert.match(staged, /^C:\/ProgramData\/ssh-approval-transfer\/incoming\/[a-f0-9]{48}\.part$/);
  } finally { await rm(root, { recursive: true }); }
});

test('Windows 전송은 승격·대상 문법·실행 경로 삽입을 연결 전에 거부한다', async () => {
  const effects = [];
  const store = { get: () => effects.push('get'), reserveDownload: () => effects.push('reserve') };
  const transport = { connect: async () => effects.push('connect') };
  const transfers = new Transfers(null, store, { platform: 'windows', transport });
  for (const op of [{ remotePath: path, elevate: true }, { remotePath: '/tmp/file', elevate: false }]) {
    await assert.rejects(transfers.upload(op)); await assert.rejects(transfers.download(op));
  }
  assert.deepEqual(effects, []);
  for (const helper of ['C:/dir/helper.ps1" & calc.exe', 'C:/dir/%USERNAME%.ps1', 'C:/dir/$(calc).ps1', 'C:/dir/../helper.ps1']) {
    assert.throws(() => new Transfers(null, store, { platform: 'windows', transport, helper }));
  }
  const spaced = new Transfers(null, store, { platform: 'windows', transport, helper: 'C:\\Program Files\\portal\\helper.ps1', remoteStage: 'C:\\ProgramData\\portal\\incoming' });
  assert.equal(spaced.remoteStage, 'C:/ProgramData/portal/incoming');
  assert.throws(() => new Transfers(null, store, { platform: 'unknown', transport }));
});
