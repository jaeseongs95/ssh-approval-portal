import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile, writeFile, symlink, readdir, stat, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { scopedArtifacts } from '../src/adapters/storage/scoped-artifacts.mjs';
import { createFileService } from '../src/application/files.mjs';
import { hash } from '../src/domain/validation.mjs';

const binding = { targetId: 'fixture', targetRevision: 'a'.repeat(64) };
const payload = Buffer.from([0, 255, 128, 65, 2, 3, 4, 5]);
const meta = { fileName: 'bytes.bin', remotePath: '/tmp/bytes.bin', size: payload.length, sha256: hash(payload),
  overwrite: false, elevate: false, operationKey: 'durable-upload-fixture', uploadProtocol: 'mcp-json-v1', fileTargetBound: true, ...binding };
async function fixture(t, { canReap = () => true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-durability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1_000;
  const openStore = async () => {
    const store = new Artifacts(root, { maxBytes: 16, budget: 32, now: () => clock, canReap });
    await store.init(); return store;
  };
  return { root, openStore, advance: n => { clock += n; }, now: () => clock };
}

test('partial uploads, operation contracts and all acknowledged chunk sequences survive restart', async t => {
  const f = await fixture(t);
  let store = await f.openStore();
  const transfer = await store.begin(meta);
  await store.append(transfer.id, 0, payload.subarray(0, 2));
  await store.append(transfer.id, 1, payload.subarray(2, 5));
  store = await f.openStore();
  assert.equal(store.reserved, payload.length);
  assert.equal((await store.begin(meta)).id, transfer.id);
  await assert.rejects(store.begin({ ...meta, remotePath: '/tmp/other.bin' }), /conflict/);
  await assert.rejects(store.begin({ ...meta, targetRevision: 'b'.repeat(64) }), /conflict/);
  assert.deepEqual(await store.append(transfer.id, 0, payload.subarray(0, 2)), { sequence: 2, received: 5 });
  await assert.rejects(store.append(transfer.id, 0, Buffer.from([1, 2])), /mismatch/);
  await store.append(transfer.id, 2, payload.subarray(5));
  await store.finish(transfer.id);
  store = await f.openStore();
  const fd = await store.verified(transfer.id);
  try {
    const actual = Buffer.alloc(payload.length);
    assert.equal((await fd.read(actual, 0, actual.length, 0)).bytesRead, actual.length);
    assert.deepEqual(actual, payload);
  }
  finally { await fd.close(); }
  assert.deepEqual(await readFile(join(f.root, transfer.id + '.part')), payload);
  assert.equal((await store.finish(transfer.id)).id, transfer.id);
  await assert.rejects(store.begin({ ...meta, operationKey: 'another-upload-fixture', size: 16, sha256: hash(Buffer.alloc(16)) }).then(() =>
    store.begin({ ...meta, operationKey: 'excess-upload-fixture', size: 16, sha256: hash(Buffer.alloc(16)) })), /budget/);
});

test('restart rolls back unacknowledged byte tails and rejects changed acknowledged bytes', async t => {
  const f = await fixture(t), store = await f.openStore();
  const transfer = await store.begin(meta);
  await store.append(transfer.id, 0, payload.subarray(0, 4));
  await appendFile(join(f.root, transfer.id + '.part'), Buffer.from('uncommitted'));
  const recovered = await f.openStore();
  assert.deepEqual(await readFile(join(f.root, transfer.id + '.part')), payload.subarray(0, 4));
  assert.equal(recovered.get(transfer.id).received, 4);
  await writeFile(join(f.root, transfer.id + '.part'), Buffer.from([9, 9, 9, 9]));
  await assert.rejects(f.openStore(), /chunk mismatch/);
});

test('completed downloads and expiration retain their metadata and quota across restart', async t => {
  const f = await fixture(t); let store = await f.openStore();
  const reserved = store.reserveDownload({ ...meta, operationKey: undefined });
  await store.receiveDownload(reserved.id, { size: payload.length, sha256: hash(payload) }, async out => { out.end(payload); });
  store = await f.openStore();
  assert.equal(store.get(reserved.id).expiresAt, f.now() + 3_600_000);
  assert.equal(store.reserved, payload.length);
  const fd = await store.verified(reserved.id); await fd.close();
  f.advance(3_600_000); await store.reap();
  assert.equal(store.size, 0); assert.equal((await f.openStore()).reserved, 0);
});

test('upload completion converges on one request and retains its submission binding after restart', async t => {
  const f = await fixture(t); let store = await f.openStore();
  const jobs = new Map(); let effects = 0;
  const queue = { maintenance: false, listAll: () => [...jobs.values()], get: id => jobs.get(id),
    submitOperation: operation => {
      const job = { id: 'b'.repeat(48), kind: 'upload', operation, state: 'pending' }; jobs.set(job.id, job); effects++; return job;
    }, startUpload() {}, rejectAutomaticDispatch() { return false; } };
  let service = createFileService({ store: scopedArtifacts(store, binding), queue, now: f.now });
  await assert.rejects(async () => service.beginAgentUpload({ ...meta, operationKey: undefined }, binding), /operation key/);
  const transfer = await service.beginAgentUpload(meta, binding);
  await service.appendAgentUpload({ id: transfer.id, sequence: 0, bytes: payload });
  const [first, second] = await Promise.all([service.finishAgentUpload(transfer.id, () => {}), service.finishAgentUpload(transfer.id, () => {})]);
  assert.equal(first.id, second.id); assert.equal(effects, 1);
  store = await f.openStore(); service = createFileService({ store: scopedArtifacts(store, binding), queue, now: f.now });
  assert.equal(store.get(transfer.id).submissionId, first.id);
  assert.equal((await service.finishAgentUpload(transfer.id, () => {})).id, first.id); assert.equal(effects, 1);
  jobs.clear();
  await assert.rejects(service.finishAgentUpload(transfer.id, () => {}), /do not replay/);
  assert.equal(effects, 1);
});

test('native download pages bind the original target and verified artifact without bearer links', async t => {
  const f = await fixture(t); let store = await f.openStore();
  const reserved = store.reserveDownload(meta);
  const ready = await store.receiveDownload(reserved.id, { size: payload.length, sha256: hash(payload) }, async out => { out.end(payload); });
  store = await f.openStore();
  const job = { id: 'c'.repeat(48), kind: 'download', state: 'completed', operation: { kind: 'download', remotePath: meta.remotePath,
    elevate: false, fileTargetId: binding.targetId, fileTargetRevision: binding.targetRevision },
    result: { failed: false, data: { artifactId: ready.id, fileName: ready.fileName, size: ready.size, sha256: ready.sha256 } } };
  const service = createFileService({ store: scopedArtifacts(store, binding), queue: { get: () => job }, now: f.now });
  let verifiedTarget = 0;
  const page = await service.readAgentDownload({ id: job.id, offsetBytes: 2, maxBytes: 3 }, () => { verifiedTarget++; });
  assert.deepEqual(Buffer.from(page.data, 'base64'), payload.subarray(2, 5));
  assert.equal(page.nextOffset, 5); assert.equal(page.bytes, 3); assert.equal(page.totalBytes, payload.length); assert.equal(verifiedTarget, 2);
  assert.equal(page.encoding, 'base64'); assert.equal(page.downloadUrl, undefined); assert.equal(page.ticket, undefined);
  const end = await service.readAgentDownload({ id: job.id, offsetBytes: payload.length, maxBytes: 1 }, () => {});
  assert.equal(end.data, ''); assert.equal(end.eof, true);
  job.operation.fileTargetRevision = 'd'.repeat(64);
  await assert.rejects(service.readAgentDownload({ id: job.id }, () => {}), /binding/);
  job.operation.fileTargetRevision = binding.targetRevision;
  await assert.rejects(service.readAgentDownload({ id: job.id }, () => { throw Error('target changed'); }), /target changed/);
  f.advance(3_600_000);
  await assert.rejects(service.readAgentDownload({ id: job.id }, () => {}), /retention/);
});

test('restoration refuses symlink metadata and leaves staged bytes intact', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), store = await f.openStore();
  const transfer = await store.begin(meta), metadata = join(f.root, transfer.id + '.json');
  const backup = join(f.root, 'manifest-backup');
  await writeFile(backup, await readFile(metadata), { mode: 0o600 });
  await rm(metadata); await symlink(backup, metadata);
  await assert.rejects(f.openStore(), /Unsafe transfer metadata/);
  assert.equal((await readFile(join(f.root, transfer.id + '.part'))).length, 0);
});

test('recovery completes a committed removal and quarantines legacy bytes without blocking startup', async t => {
  const f = await fixture(t), store = await f.openStore();
  const transfer = await store.begin(meta), metadata = join(f.root, transfer.id + '.json');
  const manifest = JSON.parse(await readFile(metadata, 'utf8'));
  await writeFile(metadata, JSON.stringify({ ...manifest, state: 'deleting' }));
  await rm(join(f.root, transfer.id + '.part')); // process stopped between byte and metadata removal
  const recovered = await f.openStore();
  assert.equal(recovered.size, 0); assert.equal(recovered.reserved, 0);
  await assert.rejects(readFile(metadata), { code: 'ENOENT' });
  const legacy = join(f.root, 'f'.repeat(48) + '.part');
  await writeFile(legacy, payload, { mode: 0o600 });
  const quarantined = await f.openStore();
  assert.equal(quarantined.size, 0); assert.equal(quarantined.reserved, payload.length);
  assert.deepEqual(await readFile(join(f.root, 'orphans', 'f'.repeat(48) + '.part')), payload);
  assert.equal(quarantined.recoveryStatus().state, 'recovery-required');
  assert.equal(quarantined.recoveryStatus().entries[0].resumable, false);
  assert.throws(() => quarantined.get('f'.repeat(48)), /Unknown transfer/);
  assert.equal((await f.openStore()).reserved, payload.length);
  await quarantined.reap();
  assert.deepEqual(await readFile(join(f.root, 'orphans', 'f'.repeat(48) + '.part')), payload);
});

test('partial upload expiration and explicit release remain effective after restart', async t => {
  const f = await fixture(t); let store = await f.openStore();
  const partial = await store.begin(meta);
  await store.append(partial.id, 0, payload.subarray(0, 4));
  f.advance(600_000); store = await f.openStore();
  await assert.rejects(store.begin(meta), /expired/);
  await assert.rejects(store.append(partial.id, 1, payload.subarray(4)), /not writable/);
  await store.reap(); assert.equal(store.size, 0);
  const complete = await store.begin({ ...meta, operationKey: 'released-upload-fixture' });
  await store.append(complete.id, 0, payload); await store.finish(complete.id);
  store.releaseUpload(complete.id, { expiresAt: f.now() + 10 });
  store = await f.openStore();
  assert.equal(store.get(complete.id).pinned, false);
  f.advance(10); await store.reap(); assert.equal(store.reserved, 0);
});

test('legacy recovery charges exact retained bytes alongside live reservations without rewriting evidence', async t => {
  const f = await fixture(t), directory = join(f.root, 'orphans');
  await mkdir(directory, { mode: 0o700 });
  const paths = [];
  for (let index = 1; index <= 8; index++) {
    const id = index.toString(16).padStart(48, '0'), part = join(directory, id + '.part'), metadata = join(directory, id + '.json');
    await writeFile(part, Buffer.from([index]), { mode: 0o600 });
    await writeFile(metadata, JSON.stringify({ version: 1, id, size: 1, reservedBytes: 16, reason: 'legacy_metadata_missing', resumable: false }), { mode: 0o600 });
    paths.push(part, metadata);
  }
  const capture = () => Promise.all(paths.map(async path => {
    const bytes = await readFile(path), info = await stat(path);
    return { path, bytes, size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }));
  const baseline = await capture();
  let store = await f.openStore();
  assert.equal(store.reserved, 8); assert.equal(store.recoveryStatus().reservedBytes, 8);
  assert.equal(store.recoveryStatus().liveReservedBytes, 0); assert.equal(store.recoveryStatus().unsafeEntries, 0);
  for (const item of store.recoveryStatus().entries) { assert.equal(item.reservedBytes, 1); assert.equal(item.resumable, false); assert.throws(() => store.get(item.id), /Unknown transfer/); }
  const live = await store.begin({ ...meta, size: 16, sha256: hash(Buffer.alloc(16)) });
  assert.equal(store.reserved, 24); assert.equal(store.recoveryStatus().liveReservedBytes, 16);
  assert.equal(store.recoveryStatus().totalReservedBytes, 24); assert.equal(store.recoveryStatus().budgetBytes, 32);
  await assert.rejects(store.begin({ ...meta, operationKey: 'legacy-budget-excess', size: 16, sha256: hash(Buffer.alloc(16)) }), { code: 'ARTIFACT_QUOTA' });
  store = await f.openStore(); assert.equal(store.reserved, 24);
  assert.equal((await store.begin({ ...meta, size: 16, sha256: hash(Buffer.alloc(16)) })).id, live.id);
  await store.remove(live.id); assert.equal(store.reserved, 8); assert.equal(store.recoveryStatus().liveReservedBytes, 0);
  f.advance(3_600_000); await store.reap(); assert.equal(store.reserved, 8);
  assert.deepEqual(await capture(), baseline);
});

test('actual retained legacy bytes still enforce the shared staging budget', async t => {
  const f = await fixture(t), id = 'd'.repeat(48), bytes = Buffer.alloc(33, 7);
  await writeFile(join(f.root, id + '.part'), bytes, { mode: 0o600 });
  const store = await f.openStore();
  assert.equal(store.reserved, bytes.length); assert.equal(store.recoveryStatus().liveReservedBytes, 0);
  await assert.rejects(store.begin({ ...meta, size: 1, sha256: hash(Buffer.from([1])) }), { code: 'ARTIFACT_QUOTA' });
  await store.reap(); assert.deepEqual(await readFile(join(f.root, 'orphans', id + '.part')), bytes);
  assert.equal((await f.openStore()).reserved, bytes.length);
});

test('unsafe legacy ownership remains preserved and conservatively charged without following or unlinking it', async t => {
  const f = await fixture(t), id = 'c'.repeat(48), source = join(f.root, 'legacy-evidence.bin'), part = join(f.root, id + '.part');
  await writeFile(source, payload, { mode: 0o600 }); await link(source, part);
  const before = await stat(part), store = await f.openStore(), recovery = store.recoveryStatus();
  assert.equal(recovery.unsafeEntries, 1); assert.equal(recovery.entries[0].reason, 'unsafe_legacy_entry');
  assert.equal(recovery.reservedBytes, 32); assert.equal(recovery.liveReservedBytes, 0); assert.equal(store.reserved, 32);
  await assert.rejects(store.begin(meta), { code: 'ARTIFACT_QUOTA' });
  await store.reap(); assert.deepEqual(await readFile(part), payload); assert.deepEqual(await readFile(source), payload);
  const after = await stat(part); assert.equal(after.ino, before.ino); assert.equal(after.nlink, before.nlink); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await f.openStore()).recoveryStatus().unsafeEntries, 1);
});

test('artifact allocation is governed by byte budget rather than a fixed item count', async t => {
  const f = await fixture(t), store = new Artifacts(f.root, { maxBytes: 16, budget: 128, now: f.now });
  await store.init();
  for (let n = 0; n < 101; n++) await store.begin({ ...meta, operationKey: `empty-artifact-${String(n).padStart(4, '0')}`, size: 0, sha256: hash(Buffer.alloc(0)) });
  assert.equal(store.size, 101); assert.equal(store.reserved, 101);
  const restored = new Artifacts(f.root, { maxBytes: 16, budget: 128, now: f.now }); await restored.init();
  assert.equal(restored.size, 101); assert.equal(restored.reserved, 101);
});

test('maintenance reaping policy preserves expired bytes, manifests and accounting until released', async t => {
  let maintenance = true;
  const f = await fixture(t, { canReap: () => !maintenance }), store = await f.openStore();
  const partial = await store.begin(meta);
  await store.append(partial.id, 0, payload.subarray(0, 4));
  const upload = await store.begin({ ...meta, operationKey: 'maintenance-ready-upload' });
  await store.append(upload.id, 0, payload); await store.finish(upload.id);
  store.releaseUpload(upload.id);
  const download = store.reserveDownload({ ...meta, operationKey: undefined });
  await store.receiveDownload(download.id, { size: payload.length, sha256: hash(payload) }, async out => { out.end(payload); });
  f.advance(3_600_000);
  const capture = async () => Promise.all((await readdir(f.root)).sort().map(async name => {
    const path = join(f.root, name), info = await stat(path, { bigint: true });
    return { name, bytes: await readFile(path), mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
  }));
  const baseline = await capture(), metadata = store.list(), reserved = store.reserved;
  await store.reap(); await store.reap();
  assert.deepEqual(await capture(), baseline);
  assert.deepEqual(store.list(), metadata); assert.equal(store.reserved, reserved); assert.equal(store.size, 3);
  await assert.rejects(store.append(partial.id, 1, payload.subarray(4)), /not writable/);
  await assert.rejects(store.finish(partial.id), /expired/);
  const downloadJob = { id: 'e'.repeat(48), kind: 'download', state: 'completed', operation: { kind: 'download', remotePath: meta.remotePath,
    elevate: false, fileTargetId: binding.targetId, fileTargetRevision: binding.targetRevision },
    result: { failed: false, data: { artifactId: download.id, fileName: meta.fileName, size: payload.length, sha256: hash(payload) } } };
  const service = createFileService({ store: scopedArtifacts(store, binding), queue: { get: () => downloadJob }, now: f.now });
  await assert.rejects(service.readAgentDownload({ id: downloadJob.id }, () => {}), /retention/);
  assert.deepEqual(await capture(), baseline);
  maintenance = false; await store.reap();
  assert.deepEqual(await readdir(f.root), []); assert.equal(store.size, 0); assert.equal(store.reserved, 0);
});
