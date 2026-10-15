import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../artifacts.mjs';
import { hash } from '../core.mjs';
test('binary and empty uploads: chunks are idempotent, hash-bound and quota-limited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-artifact-'));
  try {
    const store = new Artifacts(root, { maxBytes: 32, budget: 32 }); await store.init();
    const payload = Buffer.from([0, 255, 1, 2]), meta = { remotePath: '/tmp/한글.bin', fileName: '한글.bin', size: payload.length, sha256: hash(payload) };
    const item = await store.begin(meta);
    const ack = await store.chunk(item.id, 0, payload.toString('base64'));
    assert.deepEqual(await store.chunk(item.id, 0, payload.toString('base64')), ack);
    await assert.rejects(store.chunk(item.id, 0, Buffer.from('wrong').toString('base64')));
    await assert.rejects(store.chunk(item.id, 4, 'AA=='));
    await store.finish(item.id); assert.deepEqual(await readFile(item.path), payload);
    await assert.rejects(store.chunk(item.id, 1, 'AA=='));
    const empty = await store.begin({ ...meta, size: 0, sha256: hash(Buffer.alloc(0)) }); await store.finish(empty.id);
    await assert.rejects(store.begin({ ...meta, size: 33 }));
    const bad = await store.begin({ ...meta, sha256: hash('no') }); await store.chunk(bad.id, 0, payload.toString('base64'));
    await assert.rejects(store.finish(bad.id)); assert.ok(!store.items.has(bad.id));
  } finally { await rm(root, { recursive: true }); }
});
test('expired/incomplete uploads refuse publication and reaping frees capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-expiry-')); let now = 0;
  try {
    const store = new Artifacts(root, { maxBytes: 4, budget: 4, now: () => now }); await store.init();
    const x = await store.begin({ remotePath: '/tmp/x', fileName: 'x', size: 4, sha256: hash('test') });
    await assert.rejects(store.finish(x.id));
    await assert.rejects(store.begin({ remotePath: '/tmp/x', fileName: 'x', size: 1, sha256: hash('a') }));
    now = x.expiresAt; await assert.rejects(store.chunk(x.id, 0, 'dGVzdA=='));
    await store.reap(); assert.equal(store.reserved, 0);
  } finally { await rm(root, { recursive: true }); }
});

test('stream imports reserve capacity before opening, hash exact bytes and reuse ready-file verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-import-'));
  try {
    const store = new Artifacts(root, { maxBytes: 8, budget: 8 }); await store.init();
    const payload = Buffer.from([0, 255, 65, 128]); let release, closed = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const meta = { remotePath: '/tmp/한글.bin', fileName: '한글.bin', download_url: 'never-retain-me', overwrite: true };
    const importing = store.importFile(meta, async () => {
      await gate;
      return { stream: Readable.from([payload.subarray(0, 2), payload.subarray(2)]), expectedSize: payload.length, close: () => { closed++; } };
    });
    assert.equal(store.reserved, 8);
    await assert.rejects(store.importFile(meta, async () => assert.fail('Quota must reject before source opens')));
    for (const item of store.items.values()) assert.equal(item.busy, true);
    await store.reap(); assert.equal(store.items.size, 1);
    release(); const item = await importing;
    assert.equal(item.state, 'ready'); assert.equal(item.pinned, true);
    assert.equal(store.reserved, payload.length); assert.equal(item.sha256, hash(payload));
    assert.equal(item.download_url, undefined); assert.equal(closed, 1);
    assert.deepEqual(await readFile(item.path), payload);
    await writeFile(item.path, Buffer.alloc(payload.length));
    await assert.rejects(store.verified(item.id), /hash mismatch/);
    await store.remove(item.id);
    const empty = await store.importFile(meta, async () => ({ stream: Readable.from([]), expectedSize: 0, close() {} }));
    assert.equal(empty.size, 0); assert.equal(empty.sha256, hash(Buffer.alloc(0))); assert.equal(store.reserved, 0);
  } finally { await rm(root, { recursive: true }); }
});

test('stream import failures, truncation, overflow and cancellation leave no file or quota', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-import-errors-'));
  try {
    const store = new Artifacts(root, { maxBytes: 4, budget: 4 }); await store.init();
    const meta = { remotePath: '/tmp/x', fileName: 'x' };
    let closed = 0;
    const source = (stream, expectedSize) => async () => ({ stream, expectedSize, close: () => { closed++; } });
    for (const factory of [async () => { throw Error('fetch failed'); },
      source(Readable.from([Buffer.alloc(5)]), null), source(Readable.from([Buffer.alloc(2)]), 3),
      source(Readable.from((async function* () { yield Buffer.from('a'); throw Error('body disconnected'); })()), null)]) {
      await assert.rejects(store.importFile(meta, factory));
      assert.equal(store.reserved, 0); assert.equal(store.items.size, 0); assert.deepEqual(await readdir(root), []);
    }
    const controller = new AbortController();
    const stream = Readable.from((async function* () { yield Buffer.from('a'); controller.abort(); yield Buffer.from('b'); })());
    await assert.rejects(store.importFile(meta, source(stream, null), { signal: controller.signal }));
    assert.equal(store.reserved, 0); assert.equal(store.items.size, 0); assert.deepEqual(await readdir(root), []);
    assert.equal(closed, 4);
    await assert.rejects(store.importFile({ ...meta, fileName: '../x' }, async () => assert.fail('Invalid name fetched')));
  } finally { await rm(root, { recursive: true }); }
});
