import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { Transfers } from '../src/adapters/ssh/transfers.mjs';
import { hash } from '../src/domain/validation.mjs';
import { ApprovalQueue } from './support/approval-runtime.mjs';
import { presentJob } from '../src/adapters/presentation/results.mjs';

test('failed SSH connection releases reserved download quota and creates no local payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-disconnect-'));
  try {
    const artifacts = new Artifacts(root, { maxBytes: 32, budget: 32 }); await artifacts.init();
    const transfers = new Transfers({ getOrCreate: async () => { throw Error('synthetic disconnect'); } }, artifacts);
    await assert.rejects(transfers.download({ kind: 'download', remotePath: '/tmp/x', elevate: false }));
    assert.equal(artifacts.reserved, 0); assert.equal(artifacts.size, 0);
  } finally { await rm(root, { recursive: true }); }
});

const bytes = Buffer.from([0, 255, 1, 128]);
async function fixture({ uploadError = false, downloadError = false, wrongHash = false, cleanupError = false, helperResponse,
  platform = 'linux', pathPolicy } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-transport-contract-'));
  const store = new Artifacts(root, { maxBytes: 16, budget: 16 }); await store.init();
  const calls = [], profiles = [], uploaded = [], handles = [];
  const verified = store.verified.bind(store);
  store.verified = async id => {
    const fd = await verified(id), handle = { closed: 0 }; handles.push(handle);
    return { createReadStream: options => fd.createReadStream(options), read: (...args) => fd.read(...args),
      close: async () => { handle.closed++; await fd.close(); } };
  };
  const transport = { connect: async profile => {
    profiles.push(profile);
    return {
      async call(command, payload) {
        calls.push({ command, payload });
        if (payload.action === 'cleanup' && cleanupError) throw Error('cleanup disconnected');
        if (payload.action === 'policy') return { exitCode: 0, stdout: JSON.stringify({ protocol: 'file-path-policy-v1',
          rootPolicyApplied: 'test-server-bypass', allowedRoot: 'C:/approved' }) };
        if (payload.action !== 'cleanup' && helperResponse) return helperResponse;
        const data = payload.action === 'snapshot' ? { size: bytes.length, sha256: wrongHash ? '0'.repeat(64) : hash(bytes) } :
          payload.action === 'publish' ? { published: true, size: bytes.length, sha256: hash(bytes) } : { cleaned: true };
        return { exitCode: 0, stdout: JSON.stringify(data) };
      },
      async upload(stream, remotePath, bounds) {
        assert.match(remotePath, /\/[a-f0-9]{48}\.part$/); assert.equal(bounds.maxBytes, 16);
        for await (const chunk of stream) uploaded.push(chunk);
        if (uploadError) throw Error('upload disconnected');
      },
      async download(remotePath, destination, bounds) {
        assert.match(remotePath, /\/[a-f0-9]{48}\.part$/); assert.equal(bounds.maxBytes, 16);
        if (downloadError) throw Error('download disconnected');
        destination.end(bytes);
      },
    };
  } };
  const transfers = new Transfers(null, store, { platform, readProfile: 'reader', writeProfile: 'writer', transport,
    ...(pathPolicy ? { pathPolicy } : {}) });
  return { store, transfers, calls, profiles, uploaded, handles, root, platform, close: () => rm(root, { recursive: true }) };
}

async function uploadOperation(f) {
  const item = await f.store.begin({ fileName: 'x', remotePath: f.platform === 'windows' ? 'C:/outside/x' : '/tmp/missing-parent/x', size: 4, sha256: hash(bytes) });
  await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
  return { kind: 'upload', artifactId: item.id, fileName: 'x', remotePath: item.remotePath,
    size: 4, sha256: hash(bytes), overwrite: false, elevate: false };
}

test('upload transport streams exact binary and invokes sudo helper with frozen approved metadata, then unprivileged cleanup', async () => {
  const f = await fixture();
  try {
    const item = await f.store.begin({ fileName: 'binary.zip', remotePath: '/root/binary.zip', size: 4, sha256: hash(bytes), overwrite: true, elevate: true });
    await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
    const operation = { kind: 'upload', artifactId: item.id, remotePath: '/root/binary.zip', size: 4, sha256: hash(bytes), overwrite: true, elevate: true };
    await assert.rejects(f.transfers.upload({ ...operation, overwrite: false }), /frozen/); assert.equal(f.profiles.length, 0);
    const outcome = await f.transfers.upload(operation);
    assert.deepEqual(Buffer.concat(f.uploaded), bytes); assert.deepEqual(f.profiles, ['writer']);
    assert.equal(outcome.failed, false); assert.deepEqual(outcome.texts, ['Upload completed']); assert.equal(outcome.content, undefined);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup']);
    assert.match(f.calls[0].command, /^sudo -n /); assert.doesNotMatch(f.calls[1].command, /^sudo /);
    assert.equal(f.calls[0].payload.overwrite, true); assert.equal(f.calls[0].payload.sha256, hash(bytes)); assert.equal(f.calls[0].payload.maxBytes, 16);
  } finally { await f.close(); }
});

test('upload failure makes one attempt, never publishes and still attempts cleanup', async () => {
  const f = await fixture({ uploadError: true, cleanupError: true });
  try {
    const item = await f.store.begin({ fileName: 'x', remotePath: '/tmp/x', size: 4, sha256: hash(bytes) });
    await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
    await assert.rejects(f.transfers.upload({ artifactId: item.id, remotePath: '/tmp/x', size: 4, sha256: hash(bytes), overwrite: false, elevate: false }), /upload disconnected/);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['cleanup']); assert.deepEqual(f.profiles, ['writer']);
  } finally { await f.close(); }
});

test('download transport chooses privilege profile, retains exact binary and returns neutral metadata', async () => {
  for (const elevate of [false, true]) {
    const f = await fixture();
    try {
      const outcome = await f.transfers.download({ remotePath: '/tmp/한글.zip', elevate });
      assert.deepEqual(f.profiles, [elevate ? 'writer' : 'reader']); assert.equal(outcome.failed, false); assert.equal(outcome.data.fileName, '한글.zip');
      assert.equal(outcome.data.size, 4); assert.equal(outcome.data.sha256, hash(bytes)); assert.equal(outcome.structuredContent, undefined);
      const fd = await f.store.verified(outcome.data.artifactId);
      const received = Buffer.alloc(4); try { await fd.read(received, 0, 4, 0); } finally { await fd.close(); }
      assert.deepEqual(received, bytes); assert.equal(f.store.reserved, 4); assert.equal(f.store.hasActiveWork(), false);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['snapshot', 'cleanup']);
      assert.equal(f.calls[0].command.startsWith('sudo -n '), elevate); assert.doesNotMatch(f.calls[1].command, /^sudo /);
    } finally { await f.close(); }
  }
});

test('download transfer and hash failures clean local quota and attempt remote cleanup without retry', async () => {
  for (const options of [{ downloadError: true }, { wrongHash: true }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(f.transfers.download({ remotePath: '/tmp/x', elevate: false }));
      assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['snapshot', 'cleanup']); assert.deepEqual(f.profiles, ['reader']);
    } finally { await f.close(); }
  }
});

test('missing remote parent stays a failed queue result with safe Korean guidance through the presenter', async () => {
  const f = await fixture({ helperResponse: { exitCode: 1, stdout: JSON.stringify({ errorCode: 'PARENT_NOT_FOUND', error: '/private/secret: denied', stack: 'private stack' }) }, cleanupError: true });
  try {
    const operation = await uploadOperation(f);
    const queue = new ApprovalQueue({ classify: () => ({ class: 'safe' }), profile: 'writer', target: 'fixture',
      executeOperation: op => f.transfers.upload(op) });
    const pending = queue.submitOperation(operation);
    const failed = await queue.approve(pending.id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.result.failed, true);
    const result = presentJob(failed).result;
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { errorCode: 'PARENT_NOT_FOUND' });
    assert.deepEqual(result.content, [{ type: 'text', text: 'PARENT_NOT_FOUND: 원격 상위 폴더가 없습니다. 관리자가 폴더를 준비한 뒤 새 전송을 요청하세요.' }]);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|stack|diagnostics/);
    await assert.rejects(queue.approve(pending.id), /not pending/);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup']);
    assert.deepEqual(f.profiles, ['writer']); assert.deepEqual(f.handles.map(x => x.closed), [1]);
    assert.equal(f.calls[0].payload.overwrite, false); assert.doesNotMatch(f.calls[0].command, /^sudo /);
  } finally { await f.close(); }
});

test('known helper failure codes preserve download failure, quota release and cleanup without retry', async () => {
  for (const code of ['FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS', 'UNSAFE_PATH', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST']) {
    const f = await fixture({ helperResponse: { exitCode: 1, stdout: JSON.stringify({ errorCode: code }) } });
    try {
      const outcome = await f.transfers.download({ remotePath: '/tmp/x', elevate: false });
      assert.equal(outcome.failed, true); assert.deepEqual(outcome.data, { errorCode: code });
      assert.match(outcome.texts[0], /확인|새 (전송|요청)/);
      assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['snapshot', 'cleanup']); assert.deepEqual(f.profiles, ['reader']);
    } finally { await f.close(); }
  }
});

test('legacy, unknown, malformed and signalled helper errors expose only the fixed fallback', async () => {
  const secret = '/private/credential=do-not-expose';
  for (const response of [
    { exitCode: 1, stdout: JSON.stringify({ error: secret }) },
    { exitCode: 1, stdout: JSON.stringify({ errorCode: secret, error: secret }) },
    { exitCode: 1, stdout: secret },
    { exitCode: 1, stdout: 'null' },
    { exitCode: 1, stdout: JSON.stringify({ errorCode: '__proto__' }) },
    { exitCode: 2, stdout: JSON.stringify({ errorCode: 'PARENT_NOT_FOUND' }) },
    { exitCode: 1, signal: 'TERM', stdout: JSON.stringify({ errorCode: 'PARENT_NOT_FOUND' }) },
    { exitCode: 0, stdout: JSON.stringify({ errorCode: 'PARENT_NOT_FOUND', error: secret }) },
  ]) {
    const f = await fixture({ helperResponse: { ...response, stderr: secret } });
    try {
      const outcome = await f.transfers.upload(await uploadOperation(f));
      assert.deepEqual(outcome, { failed: true,
        texts: ['OPERATION_FAILED: 파일 작업이 실패했습니다. 관리자가 보호된 서버 진단과 대상 상태를 확인하세요. 파일이 이미 반영됐을 수 있으므로 대상 상태를 확인하기 전 재전송하지 마세요. 자동으로 재시도하지 않습니다.'],
        data: { errorCode: 'OPERATION_FAILED' } });
      assert.doesNotMatch(JSON.stringify(outcome), /private|credential|do-not-expose|__proto__/);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup']);
      assert.deepEqual(f.profiles, ['writer']); assert.deepEqual(f.handles.map(x => x.closed), [1]);
    } finally { await f.close(); }
  }
});

// 진단 계약은 오류 원점의 allowlist만 공개한다. 실제 ACL·Win32 원점은
// Windows helper/SSH suite가 검사하며 이 mock으로 실호스트 성공을 주장하지 않는다.
const privateDiagnostic = 'RAW_HELPER credential=must-not-leak SDDL private-path';
const refusedResponse = data => ({ exitCode: 1, stdout: JSON.stringify({ errorCode: 'PERMISSION_DENIED',
  error: privateDiagnostic, message: privateDiagnostic, ...data }), stderr: privateDiagnostic });
async function diagnosticFailure(data, direction = 'upload', options = {}) {
  const f = await fixture({ platform: 'windows', pathPolicy: async () => ({ bypassRoot: true }),
    helperResponse: refusedResponse(data), ...options });
  try {
    const operation = direction === 'upload' ? await uploadOperation(f)
      : { kind: 'download', remotePath: f.platform === 'windows' ? 'C:/outside/x' : '/tmp/x', elevate: false };
    const outcome = await f.transfers[direction](operation);
    assert.equal(outcome.failed, true);
    assert.doesNotMatch(JSON.stringify(outcome), /RAW_HELPER|credential|must-not-leak|SDDL|private-path/);
    assert.deepEqual(f.calls.map(x => x.payload.action), [...(f.platform === 'windows' ? ['policy'] : []),
      direction === 'upload' ? 'publish' : 'snapshot', 'cleanup']);
    assert.deepEqual(f.profiles, [direction === 'upload' ? 'writer' : 'reader']);
    for (const { command, payload } of f.calls) {
      assert.notEqual(payload.elevate, true);
      assert.doesNotMatch(command, /runas|Start-Process|sudo/);
    }
    if (direction === 'upload') { assert.deepEqual(Buffer.concat(f.uploaded), bytes); assert.deepEqual(f.handles.map(x => x.closed), [1]); }
    else { assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []); }
    return outcome;
  } finally { await f.close(); }
}

test('WRITER-DIAG-01 정책 원점은 명시한 bounded reason만 보존하고 승격·재시도하지 않는다', async () => {
  for (const policyReason of ['UNTRUSTED_OWNER', 'MISSING_DACL', 'UNSAFE_ANCESTOR', 'UNTRUSTED_WRITER',
    'UNSUPPORTED_ACE', 'SECURITY_DESCRIPTOR_TOO_LARGE']) {
    for (const direction of ['upload', 'download']) {
      const outcome = await diagnosticFailure({ origin: 'policy', policyReason, arbitrary: privateDiagnostic }, direction);
      assert.deepEqual(outcome.data, { errorCode: 'PERMISSION_DENIED', diagnostic: { origin: 'policy', policyReason } });
    }
  }
});

test('WRITER-DIAG-02 OS 원점은 검증한 단계와 정수만 공개하고 queue 실패를 유지한다', async () => {
  for (const [nativeStep, nativeError] of [['open', 5], ['read_security', 32], ['rename_new', 33],
    ['native', 0], ['write_security', 2147483647]]) {
    for (const direction of ['upload', 'download']) {
      const outcome = await diagnosticFailure({ origin: 'os', nativeStep, nativeError }, direction);
      assert.deepEqual(outcome.data, { errorCode: 'PERMISSION_DENIED', diagnostic: { origin: 'os', nativeStep, nativeError } });
      if ([32, 33].includes(nativeError)) assert.match(outcome.texts.join(' '), /공유·잠금 충돌.*대상.*상태.*자동으로 재시도하지 않습니다/);
      else assert.doesNotMatch(outcome.texts.join(' '), /공유·잠금 충돌/);
    }
  }
  const otherCode = await diagnosticFailure({ errorCode: 'OPERATION_FAILED', origin: 'os', nativeStep: 'open', nativeError: 32 });
  assert.equal(otherCode.data.errorCode, 'OPERATION_FAILED');
  assert.doesNotMatch(otherCode.texts.join(' '), /공유·잠금 충돌/);
  const f = await fixture({ platform: 'windows', helperResponse: refusedResponse({ origin: 'os', nativeStep: 'open', nativeError: 5 }) });
  try {
    const queue = new ApprovalQueue({ classify: () => ({ class: 'safe' }), profile: 'writer', target: 'fixture',
      executeOperation: operation => f.transfers.upload(operation) });
    const pending = queue.submitOperation(await uploadOperation(f));
    const job = await queue.approve(pending.id);
    assert.equal(job.state, 'failed');
    assert.equal(presentJob(job).result.isError, true);
    assert.deepEqual(presentJob(job).result.structuredContent, { errorCode: 'PERMISSION_DENIED',
      diagnostic: { origin: 'os', nativeStep: 'open', nativeError: 5 } });
    assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup']);
    await assert.rejects(queue.approve(pending.id), /not pending/);
  } finally { await f.close(); }
});

test('WRITER-DIAG-03 누락·위조·부분 진단은 추론 없이 전체 제외한다', async () => {
  const malformed = [{}, { nativeStep: 'open', nativeError: 5 }, { origin: 'policy' },
    { origin: 'policy', policyReason: privateDiagnostic }, { origin: 'policy', policyReason: true },
    { origin: 'other', policyReason: 'UNTRUSTED_WRITER' }, { nativeStep: 'verify_owner', nativeError: 0 },
    { origin: 'policy', policyReason: 'UNTRUSTED_WRITER', nativeStep: 'open' },
    { origin: 'policy', policyReason: 'UNTRUSTED_WRITER', nativeError: 5 },
    { origin: 'os', nativeStep: 'open', nativeError: 5, policyReason: 'UNTRUSTED_WRITER' },
    { diagnostic: { origin: 'policy', policyReason: 'UNTRUSTED_WRITER' } },
    ...[undefined, null, '5', true, -1, 1.5, 2147483648, 4294967295].map(nativeError => ({ origin: 'os', nativeStep: 'open', nativeError })),
    ...[undefined, null, true, privateDiagnostic, 'OPEN'].map(nativeStep => ({ origin: 'os', nativeStep, nativeError: 5 }))];
  for (const data of malformed) {
    const outcome = await diagnosticFailure(data);
    assert.deepEqual(outcome.data, { errorCode: 'PERMISSION_DENIED' });
  }
});

test('WRITER-DIAG-04 진단은 Windows의 정상 helper 실패 protocol에서만 수용한다', async () => {
  const data = { origin: 'policy', policyReason: 'UNTRUSTED_WRITER' };
  const linux = await diagnosticFailure(data, 'upload', { platform: 'linux' });
  assert.deepEqual(linux.data, { errorCode: 'PERMISSION_DENIED' });
  for (const helperResponse of [
    { ...refusedResponse(data), exitCode: 2 }, { ...refusedResponse(data), signal: 'TERM' },
    refusedResponse({ ...data, errorCode: 'UNKNOWN_CODE' }),
    { exitCode: 0, stdout: JSON.stringify({ errorCode: 'PERMISSION_DENIED', ...data }) },
  ]) {
    const outcome = await diagnosticFailure(data, 'upload', { helperResponse });
    assert.deepEqual(outcome.data, { errorCode: 'OPERATION_FAILED' });
  }
});
