import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, lstat, link, open } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withUploadSnapshot, saveDownload } from '../src/adapters/cli/local-files.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-cli-files-test-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'ssh-cli-files-test-')));
    await rm(root, { recursive: true, force: true });
  });
  const stage = join(root, 'staging'); await mkdir(stage);
  return { root, stage };
}
const allBytes = async iterable => { const parts = []; for await (const part of iterable) parts.push(part); return Buffer.concat(parts); };
const metadata = bytes => ({ size: bytes.length, sha256: hash(bytes) });

test('upload snapshot keeps exact binary bytes after source replacement, then releases its copy', async t => {
  const { root, stage } = await fixture(t), source = join(root, 'source.bin');
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0]); await writeFile(source, bytes);
  let captured;
  await withUploadSnapshot(source, async snapshot => {
    captured = snapshot; assert.equal(snapshot.size, 6); assert.equal(snapshot.sha256, '192345604f36cfa29999f86d1cb4805fa790075df3d053d566d3b9fb4d680cdc');
    await writeFile(source, 'changed');
    assert.deepEqual(await allBytes(snapshot.chunks()), bytes);
    assert.equal((await readdir(stage)).length, 1);
  }, { stagingRoot: stage });
  await assert.rejects(allBytes(captured.chunks()), { code: 'SNAPSHOT_UNAVAILABLE' });
  assert.deepEqual(await readdir(stage), []); assert.equal(await readFile(source, 'utf8'), 'changed');
});

test('empty and exact-limit snapshots work; oversized and nonregular input never reach consumer', async t => {
  const { root, stage } = await fixture(t), source = join(root, 'source');
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc')]) {
    await writeFile(source, bytes);
    await withUploadSnapshot(source, async snap => assert.deepEqual(await allBytes(snap.chunks()), bytes), { stagingRoot: stage, maxBytes: 3 });
  }
  let called = false; await writeFile(source, 'abcd');
  await assert.rejects(withUploadSnapshot(source, () => { called = true; }, { stagingRoot: stage, maxBytes: 3 }), { code: 'INVALID_LOCAL_SOURCE' });
  await assert.rejects(withUploadSnapshot(stage, () => { called = true; }, { stagingRoot: stage }), { code: 'INVALID_LOCAL_SOURCE' });
  assert.equal(called, false); assert.deepEqual(await readdir(stage), []);
});

test('snapshot rejects an observed source change during capture', async t => {
  const { root, stage } = await fixture(t), source = join(root, 'source');
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 65));
  let mutate;
  const changed = new Promise((ok, bad) => { mutate = () => writeFile(source, 'mutated').then(ok, bad); });
  const watcher = watch(stage, () => { watcher.close(); mutate(); }); t.after(() => watcher.close());
  let called = false;
  await assert.rejects(withUploadSnapshot(source, () => { called = true; }, { stagingRoot: stage }), { code: 'LOCAL_SOURCE_CHANGED' });
  await changed; assert.equal(called, false); assert.deepEqual(await readdir(stage), []);
});

test('snapshot consumer failure, early stream exit and abort release only owned staging', async t => {
  const { root, stage } = await fixture(t), source = join(root, 'source');
  await writeFile(source, Buffer.alloc(CHUNK_BYTES + 1, 7)); await writeFile(join(stage, 'keep'), 'mine');
  await assert.rejects(withUploadSnapshot(source, async snap => {
    for await (const bytes of snap.chunks()) { assert.equal(bytes.length, CHUNK_BYTES); break; }
    throw Error('consumer failed');
  }, { stagingRoot: stage }), /consumer failed/);
  const controller = new AbortController();
  await assert.rejects(withUploadSnapshot(source, async snap => {
    controller.abort(); await allBytes(snap.chunks());
  }, { stagingRoot: stage, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(stage), ['keep']); assert.equal((await lstat(source)).size, CHUNK_BYTES + 1);
});

test('download verifies binary and empty files before publishing exact bytes', async t => {
  const { root } = await fixture(t);
  for (const [i, bytes] of [Buffer.from([0, 255, 13, 10]), Buffer.alloc(0)].entries()) {
    const dest = join(root, 'file-' + i);
    const result = await saveDownload(dest, metadata(bytes), [bytes.subarray(0, 2), bytes.subarray(2)]);
    assert.deepEqual(result, { state: 'saved', ...metadata(bytes), cleanupPending: false });
    assert.deepEqual(await readFile(dest), bytes);
  }
  assert.equal((await readdir(root)).some(name => name.startsWith('.ssh-approval-download-')), false);
});

test('download mismatch, short/excessive and invalid bytes never publish', async t => {
  const { root } = await fixture(t), dest = join(root, 'output');
  const expected = metadata(Buffer.from('abc'));
  for (const chunks of [[Buffer.from('xyz')], [Buffer.from('ab')], [Buffer.from('abcd')], ['abc']]) {
    await assert.rejects(saveDownload(dest, expected, chunks));
    await assert.rejects(lstat(dest), { code: 'ENOENT' });
    assert.deepEqual(await readdir(root), ['staging']);
  }
});

test('download preserves an existing file and a racing destination', async t => {
  const { root } = await fixture(t), dest = join(root, 'output'), bytes = Buffer.from('new');
  await writeFile(dest, 'existing');
  await assert.rejects(saveDownload(dest, metadata(bytes), [bytes]), { code: 'EEXIST' });
  assert.equal(await readFile(dest, 'utf8'), 'existing');
  const raced = join(root, 'raced');
  async function *racing() { yield bytes; await writeFile(raced, 'winner', { flag: 'wx' }); }
  await assert.rejects(saveDownload(raced, metadata(bytes), racing()), { code: 'EEXIST' });
  assert.equal(await readFile(raced, 'utf8'), 'winner');
  assert.equal((await readdir(root)).some(name => name.startsWith('.ssh-approval-download-')), false);
});

test('concurrent publications have exactly one winner and retain complete bytes', async t => {
  const { root } = await fixture(t), dest = join(root, 'output');
  const a = Buffer.from('first'), b = Buffer.from('second');
  const outcomes = await Promise.allSettled([saveDownload(dest, metadata(a), [a]), saveDownload(dest, metadata(b), [b])]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason.code === 'EEXIST').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? a : b;
  assert.deepEqual(await readFile(dest), winner);
  assert.equal((await readdir(root)).some(name => name.startsWith('.ssh-approval-download-')), false);
});

test('download abort and producer error leave no destination or partial files', async t => {
  const { root } = await fixture(t), dest = join(root, 'output'), bytes = Buffer.from('abc');
  const controller = new AbortController();
  async function *abort() { yield bytes; controller.abort(); }
  await assert.rejects(saveDownload(dest, metadata(bytes), abort(), { signal: controller.signal }), { name: 'AbortError' });
  async function *broken() { yield bytes.subarray(0, 1); throw Error('network failed'); }
  await assert.rejects(saveDownload(dest, metadata(bytes), broken()), /network failed/);
  assert.deepEqual(await readdir(root), ['staging']);
});

test('download cancellation after publication preserves success and saved bytes', async t => {
  const { root } = await fixture(t), dest = join(root, 'output'), bytes = Buffer.from('done');
  const controller = new AbortController();
  const watcher = watch(root, (_event, name) => { if (name === 'output') controller.abort(); }); t.after(() => watcher.close());
  const result = await saveDownload(dest, metadata(bytes), [bytes], { signal: controller.signal });
  controller.abort(); assert.equal(result.state, 'saved'); assert.deepEqual(await readFile(dest), bytes);
});

test('hardlink destination cannot change a separate existing file', async t => {
  const { root } = await fixture(t), dest = join(root, 'output'), original = join(root, 'original');
  await writeFile(original, 'keep'); await link(original, dest);
  await assert.rejects(saveDownload(dest, metadata(Buffer.from('replace')), [Buffer.from('replace')]), { code: 'EEXIST' });
  assert.equal(await readFile(original, 'utf8'), 'keep'); assert.equal(await readFile(dest, 'utf8'), 'keep');
});

test('unsafe paths and invalid declared metadata are rejected before consuming bytes', async t => {
  const { root } = await fixture(t); let read = false;
  async function *stream() { read = true; yield Buffer.from('x'); }
  for (const size of [-1, 1.5, 65 * 1024 * 1024]) await assert.rejects(saveDownload(join(root, 'file'), { size, sha256: 'a'.repeat(64) }, stream()), { code: 'INVALID_DOWNLOAD_METADATA' });
  await assert.rejects(saveDownload('relative', metadata(Buffer.from('x')), stream()), { code: 'INVALID_LOCAL_PATH' });
  if (process.platform === 'win32') for (const path of ['C:\\NUL', 'C:\\output:stream', '\\\\server\\share\\file', 'C:\\trailing.']) await assert.rejects(saveDownload(path, metadata(Buffer.from('x')), stream()), { code: 'INVALID_LOCAL_PATH' });
  assert.equal(read, false); assert.deepEqual(await readdir(root), ['staging']);
});

test('download binds verified bytes to disk when the producer mutates its buffer after the real write', async t => {
  const { root } = await fixture(t), a = Buffer.from('original'), b = Buffer.from('modified');
  const probe = await open(join(root, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), originalWrite = prototype.write;
  await probe.close();
  let producer, barriers = 0;
  // Keep the real filesystem write. Change only the producer's alias before the
  // resolved write is handed back, deterministically exercising the ACK boundary.
  t.mock.method(prototype, 'write', async function (...args) {
    const result = await originalWrite.apply(this, args);
    producer.set(b); barriers++;
    return result;
  });
  t.after(() => t.mock.restoreAll());
  producer = Buffer.from(a);
  const rejected = join(root, 'reject');
  await assert.rejects(saveDownload(rejected, metadata(b), [producer]), { code: 'DOWNLOAD_INTEGRITY_MISMATCH' });
  await assert.rejects(lstat(rejected), { code: 'ENOENT' });
  assert.deepEqual(producer, b); assert.equal(barriers, 1);
  producer = Buffer.from(a);
  const accepted = join(root, 'accept');
  const result = await saveDownload(accepted, metadata(a), [producer]);
  assert.equal(result.state, 'saved'); assert.equal(result.sha256, hash(a));
  assert.deepEqual(await readFile(accepted), a); assert.deepEqual(producer, b);
  assert.equal(barriers, 2);
});
