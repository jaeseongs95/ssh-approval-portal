import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
