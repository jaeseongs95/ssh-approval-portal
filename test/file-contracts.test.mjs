import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createFileService } from '../src/application/files.mjs';
import { hash } from '../src/domain/validation.mjs';

const bytes = Buffer.from([0, 255, 128, 65]);
const meta = { fileName: '한글.zip', remotePath: '/tmp/한글.zip', size: bytes.length, sha256: hash(bytes), overwrite: false, elevate: false };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ssh-file-contract-')); let time = 1_000, files;
  const store = new Artifacts(root, { maxBytes: 16, budget: 32, now: () => time }); await store.init();
  const effects = [];
  const transfers = { upload: async operation => { const fd = await store.verified(operation.artifactId); await fd.close(); effects.push(operation); return { failed: false, texts: ['published'] }; },
    download: async operation => { effects.push(operation); return { failed: false, texts: ['download'] }; } };
  const queue = new ApprovalQueue({ classify: () => ({ class: 'safe' }), profile: 'write', target: 'fixture', now: () => time,
    executeOperation: operation => transfers[operation.kind](operation), onTerminal: job => files.onTerminal(job) });
  files = createFileService({ store, queue, transfers, now: () => time });
  return { store, queue, files, effects, root, advance: delta => { time += delta; },
    close: async () => { await files.close(); await rm(root, { recursive: true }); } };
}
const source = (payload = bytes) => ({ inspect: () => ({ allowed: true, sourceHost: 'files.example.test' }),
  open: async () => ({ stream: Readable.from([payload]), expectedSize: payload.length, close() {} }) });

test('store snapshots cannot alter quota/state; download completion owns hash, retention and release', async () => {
  const f = await fixture();
  try {
    const upload = await f.store.begin(meta);
    assert.equal(Object.isFrozen(upload), true); assert.equal(upload.path, undefined);
    assert.throws(() => { upload.size = 0; }, TypeError);
    assert.throws(() => { f.store.reserved = 0; }, TypeError);
    assert.equal(f.store.reserved, 4); assert.equal(f.store.hasActiveWork(), true);
    await f.store.append(upload.id, 0, bytes); await f.store.finish(upload.id);
    assert.equal(f.store.get(upload.id).busy, false); assert.equal(f.store.get(upload.id).pinned, true);
    f.store.releaseUpload(upload.id); f.store.releaseUpload(upload.id);
    await Promise.all([f.store.remove(upload.id), f.store.remove(upload.id)]);
    assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0);
    const download = f.store.reserveDownload(meta);
    assert.equal(f.store.reserved, 16); assert.equal(f.store.hasActiveWork(), true);
    const ready = await f.store.receiveDownload(download.id, { size: 4, sha256: hash(bytes) }, async destination => { destination.end(bytes); });
    assert.equal(ready.expiresAt, 3_601_000); assert.equal(ready.busy, false); assert.equal(ready.pinned, false);
    assert.equal(f.store.reserved, 4); assert.equal(f.store.hasActiveWork(), false);
    f.advance(3_600_000); await f.store.reap();
    assert.equal(f.store.reserved, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('download integrity or writer failure frees all capacity and rejects non-binary chunks', async () => {
  const f = await fixture();
  try {
    const x = await f.store.begin(meta);
    for (const invalid of ['AA==', Buffer.alloc(0), new Uint8Array(262145)]) await assert.rejects(f.store.append(x.id, 0, invalid));
    await f.store.remove(x.id);
    for (const writeTo of [async destination => { destination.end(Buffer.from('bad!')); }, async () => { throw Error('disconnect'); }]) {
      const item = f.store.reserveDownload(meta);
      await assert.rejects(f.store.receiveDownload(item.id, { size: 4, sha256: hash(bytes) }, writeTo));
      assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []);
    }
  } finally { await f.close(); }
});

test('manual and imported uploads share immutable approval and terminal release; no remote bytes before approval', async () => {
  const f = await fixture();
  try {
    const x = await f.files.beginUpload(meta);
    await f.files.appendUpload({ id: x.id, sequence: 0, bytes });
    const manual = await f.files.finishUpload(x.id);
    const imported = await f.files.requestUpload({ source: source(), ...meta, elevate: true, overwrite: true });
    assert.equal(imported.type, 'job'); assert.equal(imported.job.commandClass, 'privileged');
    assert.equal(manual.state, 'pending'); assert.equal(f.effects.length, 0); assert.equal(f.store.reserved, 8);
    assert.deepEqual(imported.job.operation, { kind: 'upload', artifactId: imported.job.operation.artifactId, remotePath: meta.remotePath,
      fileName: meta.fileName, size: 4, sha256: hash(bytes), overwrite: true, elevate: true });
    const completed = await f.queue.approve(manual.id);
    assert.equal(completed.state, 'completed'); assert.deepEqual(completed.result, { failed: false, texts: ['published'] });
    assert.throws(() => f.queue.start(manual.id), /not pending/); assert.equal(f.effects.length, 1);
    f.queue.deny(imported.job.id); await f.files.reap();
    assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0);
  } finally { await f.close(); }
});

test('source refusal is offline; abort after submission preserves approval but abort before submission releases bytes', async () => {
  const f = await fixture();
  try {
    const refused = await f.files.requestUpload({ ...meta, source: { inspect: () => ({ allowed: false, sourceHost: 'blocked.example.test' }), open: () => assert.fail('must not fetch') } });
    assert.deepEqual(refused, { type: 'source-unavailable', sourceHost: 'blocked.example.test' }); assert.equal(f.store.reserved, 0);
    const controller = new AbortController();
    const pending = await f.files.requestUpload({ ...meta, source: source() }, { signal: controller.signal });
    controller.abort(); await f.files.reap();
    assert.equal(f.queue.get(pending.job.id).state, 'pending'); assert.equal(f.store.reserved, 4);
    f.queue.deny(pending.job.id); await f.files.reap();
    const opened = deferred();
    const abortSource = { inspect: source().inspect, open: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); opened.resolve();
    }) };
    const importing = f.files.requestUpload({ ...meta, source: abortSource });
    const rejected = assert.rejects(importing, /aborted/); await opened.promise;
    assert.equal(f.files.busy(), true); await f.files.close(); await rejected;
    assert.equal(f.files.busy(), false); assert.equal(f.store.reserved, 0); assert.equal(f.effects.length, 0);
  } finally { await f.close(); }
});

test('import concurrency reserves before opening, and maintenance winning submission leaves no staged file', async () => {
  const f = await fixture(), gate = deferred(), opened = deferred(); let count = 0;
  const gated = { inspect: source().inspect, open: async () => { count++; if (count === 2) opened.resolve(); await gate.promise; return source().open(); } };
  try {
    const imports = [f.files.requestUpload({ ...meta, source: gated }), f.files.requestUpload({ ...meta, source: gated })];
    const rejections = imports.map(pending => assert.rejects(pending, /Maintenance/));
    await opened.promise; assert.equal(f.store.reserved, 32);
    await assert.rejects(f.files.requestUpload({ ...meta, source: gated }), /busy/); assert.equal(count, 2);
    f.queue.maintenance = true; gate.resolve(); await Promise.all(rejections);
    assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { gate.resolve(); await f.close(); }
});

test('ordinary and sudo downloads wait for owner without a reviewed policy', async () => {
  const f = await fixture();
  try {
    const ordinary = f.files.requestDownload({ remotePath: '/tmp/file', elevate: false });
    assert.equal(ordinary.state, 'pending'); assert.equal(f.effects.length, 0);
    assert.throws(() => f.queue.start(ordinary.id, true), /authority/);
    assert.equal((await f.queue.approve(ordinary.id)).state, 'completed'); assert.equal(f.effects.length, 1);
    await assert.rejects(f.queue.approve(ordinary.id));
    const elevated = f.files.requestDownload({ remotePath: '/root/file', elevate: true });
    assert.equal(elevated.state, 'pending'); assert.equal(elevated.commandClass, 'privileged'); assert.equal(f.effects.length, 1);
    await f.queue.approve(elevated.id); assert.equal(f.effects.length, 2);
    f.queue.maintenance = true;
    assert.throws(() => f.files.requestDownload({ remotePath: '/tmp/file' }), /Maintenance/);
  } finally { await f.close(); }
});

test('source release failure never strands a pinned upload or consumes quota', async () => {
  const f = await fixture();
  try {
    const failingRelease = { inspect: source().inspect, open: async () => ({ stream: Readable.from([bytes]), expectedSize: 4, close: async () => { throw Error('release failed'); } }) };
    await assert.rejects(f.files.requestUpload({ ...meta, source: failingRelease }), /release failed/);
    assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.equal(f.queue.list().length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});
