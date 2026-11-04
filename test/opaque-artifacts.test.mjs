import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts, CHUNK_BYTES } from '../src/adapters/storage/artifacts.mjs';
import { hash } from '../src/domain/validation.mjs';

// TEST/Actions only. Entry points are the real durable artifact store. New UUID
// staging must preserve byte/hash/quota/restart contracts without a destination.
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opaque-artifacts-'));
  t.after(() => rm(root, { recursive: true }));
  const open = async () => { const store = new Artifacts(root, { maxBytes: 1024 * 1024, budget: 4 * 1024 * 1024, ...options }); await store.init(); return store; };
  return { root, open, store: await open() };
}
const metadata = (bytes, extra = {}) => ({ ownerId: 'verified-owner', operationKey: 'opaque-upload-key-0001', fileName: '한글😀.bin', size: bytes.length, sha256: hash(bytes), ...extra });

test('staged UUID allocation is owner-bound and operation-key idempotent without a target/path', async t => {
  const { store } = await fixture(t), bytes = Buffer.from([0, 255, 13, 10]);
  const item = await store.beginStaged(metadata(bytes));
  assert.match(item.publicUUID, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(item.remotePath, undefined); assert.equal(item.targetId, undefined);
  assert.equal((await store.beginStaged(metadata(bytes))).publicUUID, item.publicUUID);
  await assert.rejects(store.beginStaged(metadata(bytes, { fileName: 'different.bin' })), /conflicts/);
  assert.throws(() => store.staged(item.publicUUID, 'other-owner'), /unavailable/);
  const other = await store.beginStaged(metadata(bytes, { ownerId: 'other-owner' }));
  assert.notEqual(other.publicUUID, item.publicUUID);
  const returned = store.get(item.id); returned.actions.push({ bad: 'caller mutation' });
  assert.deepEqual(store.get(item.id).actions, []);
});

test('raw binary chunks recover after restart, reject altered retries, and complete idempotently', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(CHUNK_BYTES + 3, 0x97);
  bytes.set([0, 0xff, 0x0a], CHUNK_BYTES);
  const item = await f.store.beginStaged(metadata(bytes));
  const first = bytes.subarray(0, CHUNK_BYTES), tail = bytes.subarray(CHUNK_BYTES);
  assert.deepEqual(await f.store.append(item.id, 0, first), { sequence: 1, received: CHUNK_BYTES });
  await appendFile(join(f.root, item.id + '.part'), Buffer.from('unacknowledged crash tail'));
  const reopened = await f.open();
  assert.equal((await lstat(join(f.root, item.id + '.part'))).size, CHUNK_BYTES);
  assert.deepEqual(await reopened.append(item.id, 0, first), { sequence: 1, received: CHUNK_BYTES });
  await assert.rejects(reopened.append(item.id, 0, Buffer.alloc(CHUNK_BYTES, 1)), /mismatch/);
  await assert.rejects(reopened.append(item.id, 1, Buffer.alloc(CHUNK_BYTES + 1)), /Invalid chunk/);
  await reopened.append(item.id, 1, tail);
  const ready = await reopened.finish(item.id);
  assert.equal(ready.pinned, false); assert.equal(ready.state, 'ready');
  assert.deepEqual(await reopened.append(item.id, 0, first), { sequence: 2, received: bytes.length });
  const again = await f.open();
  assert.equal((await again.finish(item.id)).publicUUID, item.publicUUID);
  assert.deepEqual(await readFile(join(f.root, item.id + '.part')), bytes);
});

test('empty files, final hash mismatch, staged TTL, and quota use the existing lifecycle', async t => {
  let now = 0;
  const f = await fixture(t, { maxBytes: 4, budget: 4, now: () => now });
  const item = await f.store.beginStaged(metadata(Buffer.from('test')));
  await assert.rejects(f.store.beginStaged(metadata(Buffer.from('x'), { operationKey: 'another-upload-key-02' })), { code: 'ARTIFACT_QUOTA' });
  await f.store.append(item.id, 0, Buffer.from('test')); await f.store.finish(item.id);
  now = item.expiresAt;
  await assert.rejects(f.store.finish(item.id), /expired/);
  await f.store.reap(); assert.equal(f.store.reserved, 0);
  const empty = await f.store.beginStaged(metadata(Buffer.alloc(0))); await f.store.finish(empty.id);
  assert.equal(f.store.reserved, 1);
  const bad = await f.store.beginStaged(metadata(Buffer.from('bad'), { operationKey: 'bad-upload-key-0001', sha256: hash('no') }));
  await f.store.append(bad.id, 0, Buffer.from('bad'));
  await assert.rejects(f.store.finish(bad.id), /hash mismatch/);
  assert.equal(f.store.has(bad.id), false);
});

test('consumption is a restart-safe tombstone with the original UUID and metadata', async t => {
  const f = await fixture(t), bytes = Buffer.from('consume');
  const item = await f.store.beginStaged(metadata(bytes));
  await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
  const manifest = join(f.root, item.id + '.json'), record = JSON.parse(await readFile(manifest, 'utf8'));
  record.state = 'consuming'; record.consumeReason = 'moved';
  await writeFile(manifest, JSON.stringify(record), { mode: 0o600 });
  const reopened = await f.open(), consumed = reopened.staged(item.publicUUID, 'verified-owner');
  assert.equal(consumed.state, 'consumed'); assert.equal(consumed.consumeReason, 'moved');
  assert.equal(consumed.size, bytes.length); assert.equal(consumed.sha256, hash(bytes));
  assert.equal(reopened.reserved, 1);
  await assert.rejects(lstat(join(f.root, item.id + '.part')), { code: 'ENOENT' });
  await reopened.consumeStaged(item.publicUUID, 'verified-owner', 'moved');
  assert.equal((await f.open()).staged(item.publicUUID, 'verified-owner').state, 'consumed');
});
