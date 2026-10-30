import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentUploadForwarder } from '../src/adapters/cli/agent-file-forwarder.mjs';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';

// 시험 계획: 공개 선택→실제 로컬 스냅샷→실제 클라이언트 HTTP 경계의 통합 시험.
// 기대값은 선택 전 바이트와 명시한 대상/경로이며, 서버·인증만 로컬 응답으로 대체한다.
// 범위 밖: 실제 계정·SSH·사용자 승인·운영 데이터. 프로세스 지속성은 별도 시험에서 확인한다.
const capabilityId = 'a'.repeat(48), transferId = 'b'.repeat(48), requestId = 'c'.repeat(48), revision = 'd'.repeat(64);
const token = 'SYNTHETIC.PRIVATE.CREDENTIAL';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (value, cookie = false) => new Response(JSON.stringify(value), { headers: {
  'content-type': 'application/json', ...(cookie ? { 'set-cookie': '__Host-ssh_admin_session=' + 'e'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600' } : {}),
} });
async function fixture(t, bytes = Buffer.from('PRIVATE-file-contents-\0\xff')) {
  const root = await mkdtemp(join(tmpdir(), 'agent-file-contract-')), journalRoot = join(root, 'journal'), localPath = join(root, '선택 파일.bin');
  await mkdir(journalRoot, { mode: 0o700 }); await writeFile(localPath, bytes);
  t.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'agent-file-contract-'))); await rm(root, { recursive: true, force: true }); });
  const selection = { capabilityId, localPath, remotePath: '/tmp/PRIVATE-remote.bin', target: 'default' };
  const calls = [], chunks = [], targets = { targets: [{ id: 'default', enabled: true, revision }] };
  let begin, sequence = 0, record, job, beginFailure = false, finishFailure = false, beforeBegin;
  const openClient = async origin => {
    const client = createPortalClient({ origin, accessToken: token, fetch: async (url, options) => {
      const path = new URL(url).pathname; calls.push({ path, method: options.method });
      if (path === '/api/session') return json({ mode: 'access' });
      if (path === '/api/session/start') return json({ connected: true }, true);
      if (path === '/api/session/logout') return json({ connected: false });
      if (path === '/api/targets') return json(targets);
      if (path === '/api/files/uploads') {
        begin = JSON.parse(options.body); await beforeBegin?.();
        if (beginFailure) throw Error('PRIVATE-unknown-begin-' + token);
        record = { id: transferId, state: 'staging', fileTargetBound: true, targetId: begin.target, targetRevision: begin.expectedTargetRevision,
          remotePath: begin.remotePath, elevate: begin.elevate, overwrite: begin.overwrite, size: begin.size, sha256: begin.sha256,
          received: 0, sequence: 0, expiresAt: Date.now() + 600000 };
        return json({ transferId, received: 0, sequence: 0 });
      }
      if (path === '/api/files/uploads/' + transferId) return json(job ? { job } : { transfer: record });
      if (path.endsWith('/chunks')) {
        const part = JSON.parse(options.body); assert.equal(part.sequence, sequence++);
        chunks.push(Buffer.from(part.data, 'base64')); record.sequence = sequence; record.received = Buffer.concat(chunks).length;
        return json({ sequence, received: record.received });
      }
      if (path.endsWith('/finish')) {
        if (finishFailure) throw Error('PRIVATE-unknown-finish-' + token);
        job = { id: requestId, state: 'pending', kind: 'upload', operation: { kind: 'upload', artifactId: transferId,
          remotePath: begin.remotePath, elevate: begin.elevate, overwrite: begin.overwrite, size: begin.size, sha256: begin.sha256,
          fileTargetId: begin.target, fileTargetRevision: begin.expectedTargetRevision } };
        return json(job);
      }
      if (path === '/api/' + requestId) return json(job);
      assert.fail('예상하지 못한 시험 경로: ' + path);
    } });
    await client.connect(); return client;
  };
  const create = () => createAgentUploadForwarder({ origin: 'https://fixture.invalid', journalRoot, openClient });
  return { root, journalRoot, localPath, selection, calls, chunks, targets, bytes, create, api: await create(),
    begin: () => begin, starts: () => calls.filter(x => x.path === '/api/files/uploads').length,
    effects: () => calls.filter(x => x.method === 'POST' && !x.path.startsWith('/api/session')),
    loseBegin: () => { beginFailure = true; }, loseFinish: value => { finishFailure = value; }, mutateAtBegin: fn => { beforeBegin = fn; } };
}
const args = { capabilityId };
function publicOnly(value, f) {
  const encoded = JSON.stringify(value);
  for (let privateValue of [token, f.localPath, f.selection.remotePath, f.bytes.toString('base64'), 'PRIVATE-file-contents', 'PRIVATE-unknown'].filter(Boolean)) {
    for (let layer = 0; layer < 3; layer++) { assert.equal(encoded.includes(privateValue), false); privateValue = JSON.stringify(privateValue).slice(1, -1); }
  }
}

test('임의 바이너리와 빈 파일 선택은 메타데이터만 반환하고 명시 업로드에서 원래 바이트와 대상을 전달한다', async t => {
  const binary = Buffer.alloc(CHUNK_BYTES + 9); for (let n = 0; n < binary.length; n++) binary[n] = n % 251;
  for (const bytes of [binary, Buffer.alloc(0)]) {
    const f = await fixture(t, bytes), selected = await f.api.selectUpload(f.selection);
    assert.deepEqual(Object.keys(selected).sort(), ['capabilityId', 'publicName', 'sha256', 'size', 'state', 'direction'].sort());
    assert.equal(selected.capabilityId, capabilityId); assert.equal(selected.state, 'available'); assert.equal(selected.size, bytes.length); assert.equal(selected.sha256, sha(bytes));
    assert.equal(f.effects().length, 0); publicOnly(selected, f); publicOnly(await f.api.list({}), f);
    const uploaded = await f.api.invoke('upload', args); assert.equal(uploaded.state, 'pending'); assert.equal(uploaded.requestId, requestId);
    assert.deepEqual(Buffer.concat(f.chunks), bytes); assert.equal(f.starts(), 1);
    assert.equal(f.begin().target, 'default'); assert.equal(f.begin().expectedTargetRevision, revision); assert.equal(f.begin().remotePath, f.selection.remotePath);
    assert.equal(f.begin().elevate, false); assert.equal(f.begin().overwrite, false); publicOnly(uploaded, f);
  }
});

test('같은 선택은 파일 삭제와 재시작 뒤에도 재조회 없이 돌아오고 다른 의도는 거절된다', async t => {
  const f = await fixture(t), selected = await f.api.selectUpload(f.selection), before = f.calls.length;
  await rm(f.localPath); assert.deepEqual(await f.api.selectUpload({ ...f.selection, elevate: false, overwrite: false }), selected);
  const restarted = await f.create(); assert.deepEqual(await restarted.selectUpload(f.selection), selected); assert.equal(f.calls.length, before);
  for (const change of [{ localPath: join(f.root, 'other') }, { remotePath: '/tmp/other' }, { target: 'other' }, { elevate: true }, { overwrite: true }]) {
    await assert.rejects(restarted.selectUpload({ ...f.selection, ...change }));
  }
  assert.equal(f.calls.length, before); assert.equal(f.effects().length, 0);
});

test('선택 뒤 소스가 바뀌면 원래 해시로 거절하고 원격 전송을 시작하지 않는다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection); await writeFile(f.localPath, Buffer.alloc(f.bytes.length, 42));
  const result = await f.api.invoke('upload', args); assert.equal(result.state, 'unknown'); assert.equal(result.error, 'UPLOAD_SOURCE_MISMATCH');
  assert.equal(f.starts(), 0); publicOnly(result, f);
});

test('원격 시작 뒤 소스 교체는 실제 불변 스냅샷의 바이트를 바꾸지 않는다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection); f.mutateAtBegin(() => writeFile(f.localPath, 'replacement'));
  assert.equal((await f.api.invoke('upload', args)).state, 'pending'); assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
});

test('동시 선택과 동시 실행 및 재시작은 원격 전송을 한 번만 만든다', async t => {
  const f = await fixture(t), other = await f.create();
  const selected = await Promise.all([f.api.selectUpload(f.selection), other.selectUpload(f.selection)]); assert.deepEqual(selected[0], selected[1]);
  const results = await Promise.all([f.api.invoke('upload', args), other.invoke('upload', args)]); assert.ok(results.some(x => x.requestId === requestId)); assert.equal(f.starts(), 1);
  const restarted = await f.create(); assert.equal((await restarted.invoke('upload', args)).requestId, requestId); assert.equal(f.starts(), 1);
});

test('대상 revision 변경 또는 비활성화는 선택 당시 의도를 새 대상으로 바꾸지 않는다', async t => {
  for (const change of [{ revision: 'f'.repeat(64) }, { enabled: false }]) {
    const f = await fixture(t); await f.api.selectUpload(f.selection); Object.assign(f.targets.targets[0], change);
    const result = await f.api.invoke('upload', args); assert.equal(result.error, 'CAPABILITY_TARGET_UNAVAILABLE'); assert.equal(f.starts(), 0);
  }
});

test('선택 시 누락되거나 비활성 또는 중복된 대상은 고정할 수 없다', async t => {
  for (const targets of [[], [{ id: 'default', enabled: false, revision }], [{ id: 'default', enabled: true }], [{ id: 'default', enabled: true, revision }, { id: 'default', enabled: true, revision }]]) {
    const f = await fixture(t); f.targets.targets = targets; await assert.rejects(f.api.selectUpload(f.selection)); assert.equal(f.effects().length, 0);
    assert.deepEqual((await f.api.list({})).capabilities, []);
  }
});

test('결과 불명 시작은 재시작·재실행·재개에서 새 업로드를 만들지 않는다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection); f.loseBegin();
  const result = await f.api.invoke('upload', args); assert.equal(result.state, 'unknown'); publicOnly(result, f); assert.equal(f.starts(), 1);
  const restarted = await f.create(); for (const action of ['upload', 'resume-upload', 'status']) {
    const next = await restarted.invoke(action, args); assert.equal(next.state, 'unknown'); publicOnly(next, f);
  }
  assert.equal(f.starts(), 1);
});

test('알려진 전송은 같은 바이트·전송 ID로 명시 재개하고 새 업로드를 만들지 않는다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection); f.loseFinish(true);
  assert.equal((await f.api.invoke('upload', args)).state, 'unknown'); f.loseFinish(false);
  const restarted = await f.create(); assert.equal((await restarted.invoke('status', args)).state, 'staging');
  assert.equal((await restarted.invoke('resume-upload', args)).requestId, requestId); assert.equal(f.starts(), 1); assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
});

test('선택된 업로드에 다운로드·저장을 적용해도 원격 변형은 없다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection);
  for (const action of ['request-download', 'save']) await assert.rejects(f.api.invoke(action, args), { code: 'CAPABILITY_ACTION_REFUSED' });
  assert.equal(f.effects().length, 0);
});

test('엄격한 선택 입력과 일반 파일이 아닌 경로는 업로드 없이 거절된다', async t => {
  const f = await fixture(t);
  for (const change of [{ capabilityId: 'z'.repeat(48) }, { localPath: 'relative' }, { remotePath: 'relative' }, { command: 'id' }, { elevate: 'true' }, { overwrite: 'true' }, { target: '../other' }]) {
    await assert.rejects(f.api.selectUpload({ ...f.selection, ...change }));
  }
  await assert.rejects(f.api.selectUpload({ ...f.selection, localPath: f.root })); assert.equal(f.effects().length, 0);
});

test('파일 심볼릭 링크는 선택할 수 없다', async t => {
  const f = await fixture(t);
  const link = join(f.root, 'source-link');
  try { await symlink(f.localPath, link, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('심볼릭 링크 생성 권한이 없어 해당 경로 검사는 미실행'); return; } throw error;
  }
  await assert.rejects(f.api.selectUpload({ ...f.selection, localPath: link })); assert.equal(f.effects().length, 0);
});

test('손상된 선택 기록은 재선택으로 복구하거나 새 업로드를 만들지 않는다', async t => {
  const f = await fixture(t); await f.api.selectUpload(f.selection);
  const files = await readdir(f.journalRoot), manifests = [];
  for (const name of files) { try { const value = JSON.parse(await readFile(join(f.journalRoot, name), 'utf8')); if (value.origin || value.capabilities || value.selection) manifests.push(name); } catch {} }
  assert.ok(manifests.length > 0, '선택 의도를 담은 지속 기록이 있어야 한다');
  await writeFile(join(f.journalRoot, manifests[0]), '{'); const before = f.calls.length;
  const restarted = await f.create().catch(() => null);
  if (restarted) await assert.rejects(restarted.selectUpload(f.selection));
  assert.equal(f.calls.length, before); assert.equal(f.starts(), 0);
});
