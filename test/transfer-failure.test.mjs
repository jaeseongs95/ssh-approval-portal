import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { Transfers } from '../src/adapters/ssh/transfers.mjs';
import { hash } from '../src/domain/validation.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
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
async function fixture({ uploadError = false, downloadError = false, wrongHash = false, cleanupError = false, helperResponse } = {}) {
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
  const transfers = new Transfers(null, store, { readProfile: 'reader', writeProfile: 'writer', transport });
  return { store, transfers, calls, profiles, uploaded, handles, root, close: () => rm(root, { recursive: true }) };
}

async function uploadOperation(f) {
  const item = await f.store.begin({ fileName: 'x', remotePath: '/tmp/missing-parent/x', size: 4, sha256: hash(bytes) });
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
