import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { Transfers } from '../src/adapters/ssh/transfers.mjs';
import { hash } from '../src/domain/validation.mjs';

// 공개 Transfers 경계의 정책 출처·보조프로그램 호환성·실패 결과를 검사한다.
// 실제 Windows ACL과 설치된 helper는 Windows SSH/PowerShell 통합 시험 범위다.
const bytes = Buffer.from([0, 255, 13, 10, 128]);
const remotePath = 'C:/outside-configured-root/한글.bin';
const revision = 'b'.repeat(64);
const binding = { fileTargetId: 'windows', fileTargetRevision: revision };
const echo = 'test-server-bypass';
const untrusted = 'RAW_REMOTE_DIAGNOSTIC credential=must-not-leak';
const response = (data, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(data), stderr: untrusted });

async function fixture({ pathPolicy, helperResponse, policyResponse, platform = 'windows', boundCleanup = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'test-mode-path-policy-'));
  const store = new Artifacts(root, { maxBytes: 32, budget: 128 });
  await store.init();
  const calls = [], profiles = [], connections = [], uploads = [], downloads = [], events = [];
  let cleanupCalls = 0;
  const session = {
    async call(command, payload) {
      calls.push({ command, payload });
      events.push(payload.action);
      if (payload.action === 'policy') return policyResponse ?? response({ protocol: 'file-path-policy-v1', rootPolicyApplied: echo, allowedRoot: 'C:/approved' });
      if (['publish', 'snapshot'].includes(payload.action) && helperResponse) return helperResponse;
      return response(payload.action === 'snapshot'
        ? { size: bytes.length, sha256: hash(bytes), ...(payload.bypassRoot === true ? { rootPolicyApplied: echo } : {}) }
        : payload.action === 'authorize' ? { authorized: true, elevated: true, ...(payload.bypassRoot === true ? { rootPolicyApplied: echo } : {}) }
        : payload.action === 'cleanup' ? { cleaned: true }
        : { published: true, ...(payload.bypassRoot === true ? { rootPolicyApplied: echo } : {}) });
    },
    async upload(stream, path) { events.push('sftp-upload'); uploads.push(path); for await (const chunk of stream) assert.deepEqual(chunk, bytes); },
    async download(path, destination) { events.push('sftp-download'); downloads.push(path); destination.end(bytes); },
    ...(boundCleanup ? { async cleanup() { cleanupCalls++; return response({ cleaned: true }); } } : {}),
  };
  const transfers = new Transfers(null, store, { platform, readProfile: 'reader', writeProfile: 'writer',
    ...(pathPolicy === undefined ? {} : { pathPolicy }),
    transport: { async connect(profile, options) { profiles.push(profile); connections.push(options); return session; } } });
  const path = platform === 'windows' ? remotePath : '/outside-configured-root/file.bin';
  async function uploadOperation({ elevate = false } = {}) {
    const item = await store.begin({ fileName: '한글.bin', remotePath: path, size: bytes.length,
      sha256: hash(bytes), overwrite: false, elevate, targetId: 'windows', targetRevision: revision, fileTargetBound: true });
    await store.append(item.id, 0, bytes); await store.finish(item.id);
    return { kind: 'upload', artifactId: item.id, remotePath: path, size: bytes.length, sha256: hash(bytes), overwrite: false, elevate, ...binding };
  }
  return { store, transfers, calls, profiles, connections, uploads, downloads, events, uploadOperation,
    downloadOperation: { kind: 'download', remotePath: path, elevate: false, ...binding },
    get cleanupCalls() { return cleanupCalls; }, close: () => rm(root, { recursive: true }) };
}

test('TM-PATH-01 기본 정책과 위조한 operation 필드는 root 우회 권한을 만들지 않는다', async () => {
  for (const pathPolicy of [undefined, async () => ({ bypassRoot: false }), async () => ({ bypassRoot: 'true' }), async () => ({ bypassRoot: 1 })]) {
    const f = await fixture({ pathPolicy });
    try {
      const forged = { bypassRoot: true, testServer: true, rootPolicyApplied: echo };
      assert.equal((await f.transfers.upload({ ...await f.uploadOperation(), ...forged })).failed, false);
      assert.equal((await f.transfers.download({ ...f.downloadOperation, ...forged })).failed, false);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup', 'snapshot', 'cleanup']);
      for (const { payload } of f.calls) {
        assert.equal(Object.hasOwn(payload, 'bypassRoot'), false);
        assert.equal(Object.hasOwn(payload, 'testServer'), false);
        assert.equal(Object.hasOwn(payload, 'rootPolicyApplied'), false);
      }
    } finally { await f.close(); }
  }
});

test('TM-PATH-02 서버 정책의 명시적 true는 파일 변경 전에 helper 호환성을 확인한다', async () => {
  const policies = [];
  const f = await fixture({ pathPolicy: async op => { policies.push(op); return { bypassRoot: true }; } });
  try {
    const operation = await f.uploadOperation();
    assert.equal((await f.transfers.upload({ ...operation, bypassRoot: false })).failed, false);
    assert.equal((await f.transfers.download(f.downloadOperation)).failed, false);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['policy', 'publish', 'cleanup', 'policy', 'snapshot', 'cleanup']);
    assert.deepEqual(f.events, ['policy', 'sftp-upload', 'publish', 'cleanup', 'policy', 'snapshot', 'sftp-download', 'cleanup']);
    for (const { payload, command } of f.calls) {
      assert.equal(payload.bypassRoot, ['policy', 'publish', 'snapshot'].includes(payload.action) ? true : undefined);
      assert.equal(payload.elevate, false);
      assert.doesNotMatch(command, /runas|Start-Process|sudo/);
    }
    assert.ok(policies.length >= 2);
    for (const op of policies) {
      assert.equal(op.fileTargetId, 'windows');
      assert.equal(op.fileTargetRevision, revision);
      assert.equal(op.remotePath, remotePath);
    }
    assert.deepEqual(f.profiles, ['writer', 'reader']);
  } finally { await f.close(); }
});

test('TM-PATH-03 Linux 전송은 Windows root 우회 payload를 받지 않는다', async () => {
  const f = await fixture({ platform: 'linux', pathPolicy: async () => ({ bypassRoot: true }) });
  try {
    assert.equal((await f.transfers.upload(await f.uploadOperation())).failed, false);
    assert.equal((await f.transfers.download(f.downloadOperation)).failed, false);
    for (const { payload } of f.calls) assert.equal(Object.hasOwn(payload, 'bypassRoot'), false);
  } finally { await f.close(); }
});

test('TM-PATH-04 우회 echo가 없거나 다르면 성공 응답도 실패로 처리하고 재시도하지 않는다', async () => {
  for (const rootPolicyApplied of [undefined, 'configured-root', true, 'TEST-SERVER-BYPASS']) {
    for (const direction of ['upload', 'download']) {
      const data = { published: true, size: bytes.length, sha256: hash(bytes), ...(rootPolicyApplied === undefined ? {} : { rootPolicyApplied }) };
      const f = await fixture({ pathPolicy: async () => ({ bypassRoot: true }), helperResponse: response(data) });
      try {
        const operation = direction === 'upload' ? await f.uploadOperation() : f.downloadOperation;
        const outcome = await f.transfers[direction](operation);
        assert.equal(outcome.failed, true);
        assert.deepEqual(outcome.data, { errorCode: 'PATH_POLICY_UNSUPPORTED' });
        assert.doesNotMatch(JSON.stringify(outcome), /RAW_REMOTE_DIAGNOSTIC|credential|must-not-leak/);
        assert.deepEqual(f.calls.map(x => x.payload.action), ['policy', direction === 'upload' ? 'publish' : 'snapshot', 'cleanup']);
        assert.equal(f.profiles.length, 1);
        assert.equal(f.downloads.length, 0);
        if (direction === 'download') { assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); }
      } finally { await f.close(); }
    }
  }
});

test('TM-PATH-05 root 제한 오류는 검증한 allowedRoot만 공개하고 helper 원문을 버린다', async () => {
  for (const allowedRoot of ['C:/approved files', 'D:\\승인 파일']) {
    const f = await fixture({ helperResponse: response({ errorCode: 'PATH_OUTSIDE_ALLOWED_ROOT', allowedRoot,
      error: untrusted, message: untrusted, diagnostics: { secret: untrusted } }, 1) });
    try {
      const outcome = await f.transfers.download(f.downloadOperation);
      assert.equal(outcome.failed, true);
      assert.deepEqual(outcome.data, { errorCode: 'PATH_OUTSIDE_ALLOWED_ROOT', allowedRoot });
      assert.match(outcome.texts.join(' '), /PATH_OUTSIDE_ALLOWED_ROOT/);
      assert.doesNotMatch(JSON.stringify(outcome), /RAW_REMOTE_DIAGNOSTIC|credential|must-not-leak|diagnostics/);
    } finally { await f.close(); }
  }
});

test('TM-PATH-06 유효하지 않은 allowedRoot는 root 제한 오류에도 공개하지 않는다', async () => {
  for (const allowedRoot of [undefined, null, true, {}, 'C:/', 'C:relative', '/private/root', '\\\\server\\share',
    'C:/safe/../secret', 'C:/file:stream', 'C:/NUL', 'C:/hidden\u200b', 'C:/root\nRAW_REMOTE_DIAGNOSTIC', 'C:/' + 'x'.repeat(4094)]) {
    const f = await fixture({ helperResponse: response({ errorCode: 'PATH_OUTSIDE_ALLOWED_ROOT', allowedRoot, error: untrusted }, 1) });
    try {
      const outcome = await f.transfers.download(f.downloadOperation);
      assert.equal(outcome.failed, true);
      assert.deepEqual(outcome.data, { errorCode: 'PATH_OUTSIDE_ALLOWED_ROOT' });
      assert.doesNotMatch(JSON.stringify(outcome), /RAW_REMOTE_DIAGNOSTIC|credential|must-not-leak|private|relative|file:stream/);
    } finally { await f.close(); }
  }
});

test('TM-PATH-07 우회 모드에서도 SSH 권한 거부는 실패이며 승격과 재시도가 없다', async () => {
  for (const direction of ['upload', 'download']) {
    const f = await fixture({ pathPolicy: async () => ({ bypassRoot: true }),
      helperResponse: response({ errorCode: 'PERMISSION_DENIED', allowedRoot: 'C:/secret', error: untrusted, rootPolicyApplied: echo }, 1) });
    try {
      const operation = direction === 'upload' ? await f.uploadOperation() : f.downloadOperation;
      const outcome = await f.transfers[direction](operation);
      assert.equal(outcome.failed, true);
      assert.deepEqual(outcome.data, { errorCode: 'PERMISSION_DENIED' });
      assert.match(outcome.texts.join(' '), /PERMISSION_DENIED/);
      assert.doesNotMatch(JSON.stringify(outcome), /RAW_REMOTE_DIAGNOSTIC|credential|must-not-leak|C:\/secret/);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['policy', direction === 'upload' ? 'publish' : 'snapshot', 'cleanup']);
      assert.deepEqual(f.profiles, [direction === 'upload' ? 'writer' : 'reader']);
      for (const { command, payload } of f.calls) {
        assert.equal(payload.elevate, false);
        assert.doesNotMatch(command, /runas|Start-Process|sudo/);
      }
      if (direction === 'download') { assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); }
    } finally { await f.close(); }
  }
});

test('TM-PATH-08 우회 정책은 명시된 승격 의도와 정리 권한을 바꾸지 않는다', async () => {
  const f = await fixture({ pathPolicy: async () => ({ bypassRoot: true }) });
  try {
    assert.equal((await f.transfers.upload(await f.uploadOperation({ elevate: true }))).failed, false);
    assert.deepEqual(f.events, ['policy', 'authorize', 'sftp-upload', 'publish', 'cleanup']);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['policy', 'authorize', 'publish', 'cleanup']);
    assert.deepEqual(f.calls.map(x => x.payload.elevate), [true, true, true, false]);
    assert.deepEqual(f.calls.map(x => x.payload.bypassRoot), [true, true, true, undefined]);
    assert.deepEqual(f.profiles, ['writer']);
    for (const { command } of f.calls) assert.doesNotMatch(command, /runas|Start-Process|sudo/);
  } finally { await f.close(); }
});

test('TM-PATH-09 연결에 고정한 정리는 helper 정책을 다시 요청하거나 우회하지 않는다', async () => {
  let policyCalls = 0;
  const f = await fixture({ boundCleanup: true, pathPolicy: async () => { policyCalls++; return { bypassRoot: true }; } });
  try {
    const operation = await f.uploadOperation();
    assert.equal((await f.transfers.upload(operation)).failed, false);
    assert.equal((await f.transfers.download(f.downloadOperation)).failed, false);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['policy', 'publish', 'policy', 'snapshot']);
    assert.ok(policyCalls >= 2);
    assert.equal(f.cleanupCalls, 2);
    for (const [index, options] of f.connections.entries()) {
      assert.deepEqual(Object.keys(options.cleanup).sort(), ['helper', 'id', 'platform']);
      assert.equal(options.cleanup.platform, 'windows');
      assert.equal(options.cleanup.helper, 'C:/ProgramData/ssh-approval-portal/windows-file-helper.ps1');
      assert.match(options.cleanup.id, /^[a-f0-9]{48}$/);
      if (index === 0) assert.equal(options.cleanup.id, operation.artifactId);
    }
  } finally { await f.close(); }
});

test('TM-PATH-10 구형 또는 불일치 policy 응답은 SFTP와 publish 및 snapshot 전에 거부한다', async () => {
  for (const data of [{ errorCode: 'INVALID_REQUEST' }, { ok: true }, { protocol: 'file-path-policy-v0', rootPolicyApplied: echo, allowedRoot: 'C:/approved' },
    { protocol: 'file-path-policy-v1', rootPolicyApplied: 'configured-root', allowedRoot: 'C:/approved' },
    { protocol: 'file-path-policy-v1', rootPolicyApplied: echo, allowedRoot: '/not-windows' }]) {
    for (const direction of ['upload', 'download']) {
      const f = await fixture({ pathPolicy: async () => ({ bypassRoot: true }), policyResponse: response(data, data.errorCode ? 1 : 0) });
      try {
        const operation = direction === 'upload' ? await f.uploadOperation() : f.downloadOperation;
        const outcome = await f.transfers[direction](operation);
        assert.equal(outcome.failed, true);
        assert.deepEqual(outcome.data, { errorCode: 'PATH_POLICY_UNSUPPORTED' });
        assert.deepEqual(f.calls.filter(x => x.payload.action !== 'cleanup').map(x => x.payload.action), ['policy']);
        assert.deepEqual(f.uploads, []); assert.deepEqual(f.downloads, []);
        assert.equal(f.profiles.length, 1);
        assert.doesNotMatch(JSON.stringify(outcome), /RAW_REMOTE_DIAGNOSTIC|credential|must-not-leak/);
        if (direction === 'download') { assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); }
      } finally { await f.close(); }
    }
  }
});
