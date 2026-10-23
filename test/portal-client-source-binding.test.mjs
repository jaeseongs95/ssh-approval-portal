import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as clientModule from '../src/adapters/cli/portal-client.mjs';
import { main } from '../scripts/portal-client.mjs';
import { MAX_BYTES, CHUNK_BYTES } from '../src/contracts/ports.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const token = 'SYNTHETIC.PRIVATE.CREDENTIAL', originalFetch = globalThis.fetch;
const transferId = 'a'.repeat(48), requestId = 'b'.repeat(48);
const json = (value, cookie = false) => new Response(JSON.stringify(value), { status: 200, headers: {
  'content-type': 'application/json', ...(cookie ? { 'set-cookie': '__Host-ssh_admin_session=' + 'c'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600' } : {}),
} });
async function fixture(t, bytes = Buffer.from('declared source')) {
  const root = await mkdtemp(join(tmpdir(), 'source-binding-')), source = join(root, '선언 파일.bin');
  await writeFile(source, bytes);
  const calls = [], chunks = []; let begin, sequence = 0;
  const f = { root, source, bytes, calls, chunks, beforeBegin: null, beginFailure: false };
  f.send = async (url, options) => {
    const path = new URL(url).pathname; calls.push({ method: options.method, path });
    if (path === '/api/session') return json({ mode: 'access' });
    if (path === '/api/session/start') return json({ connected: true }, true);
    if (path === '/api/session/logout') return json({ connected: false });
    if (path === '/api/files/uploads') {
      begin = JSON.parse(options.body); if (f.beforeBegin) await f.beforeBegin();
      if (f.beginFailure) throw Error('PRIVATE_RAW_DIAGNOSTIC');
      return json({ transferId, received: 0, sequence: 0 });
    }
    if (path.endsWith('/chunks')) {
      const part = JSON.parse(options.body); assert.equal(part.sequence, sequence++);
      chunks.push(Buffer.from(part.data, 'base64'));
      return json({ sequence, received: Buffer.concat(chunks).length });
    }
    if (path.endsWith('/finish')) return json({ id: requestId, state: 'pending', kind: 'upload', operation: { ...begin, kind: 'upload', artifactId: transferId } });
    assert.fail('Unexpected endpoint');
  };
  f.client = clientModule.createPortalClient({ origin: 'https://fixture.invalid', accessToken: token, fetch: f.send });
  await f.client.connect();
  t.after(async () => { await f.client.close(); assert.ok(root.startsWith(join(tmpdir(), 'source-binding-'))); await rm(root, { recursive: true, force: true }); globalThis.fetch = originalFetch; });
  f.beginCount = () => calls.filter(row => row.path === '/api/files/uploads').length;
  f.upload = expected => f.client.upload(source, { remotePath: '/tmp/declared.bin', elevate: false, overwrite: false }, undefined, expected);
  f.beginBody = () => begin;
  return f;
}

test('source expectation validates exact own fields and freezes a primitive copy', () => {
  assert.equal(typeof clientModule.validateUploadExpectation, 'function');
  const validate = clientModule.validateUploadExpectation;
  assert.equal(validate(undefined), undefined);
  for (const size of [0, MAX_BYTES]) {
    const input = { size, sha256: 'a'.repeat(64) }, checked = validate(input);
    input.size = 7; input.sha256 = 'b'.repeat(64);
    assert.deepEqual(checked, { size, sha256: 'a'.repeat(64) }); assert.equal(Object.isFrozen(checked), true);
  }
  for (const value of [null, [], '', {}, { size: 0 }, { sha256: 'a'.repeat(64) }, { size: -1, sha256: 'a'.repeat(64) },
    { size: MAX_BYTES + 1, sha256: 'a'.repeat(64) }, { size: '0', sha256: 'a'.repeat(64) }, { size: 1.5, sha256: 'a'.repeat(64) },
    { size: 0, sha256: 'A'.repeat(64) }, { size: 0, sha256: ['a'.repeat(64)] }, { size: 0, sha256: 'a'.repeat(64), extra: true },
    Object.create({ size: 0, sha256: 'a'.repeat(64) })]) assert.throws(() => validate(value), { code: 'INVALID_UPLOAD_EXPECTATION' });
});

test('declared binary and empty snapshots upload exact bytes without expectation fields on the wire', async t => {
  const binary = Buffer.alloc(CHUNK_BYTES + 9); for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
  for (const bytes of [binary, Buffer.alloc(0)]) {
    const f = await fixture(t, bytes), result = await f.upload({ size: bytes.length, sha256: hash(bytes) });
    assert.equal(result.id, requestId); assert.equal(f.beginCount(), 1);
    assert.deepEqual(Buffer.concat(f.chunks), bytes);
    assert.deepEqual(Object.keys(f.beginBody()).sort(), ['fileName', 'size', 'sha256', 'remotePath', 'elevate', 'overwrite'].sort());
  }
});

test('size and SHA mismatch refuse before remote begin, transfer callback or bytes', async t => {
  for (const expected of [{ size: 999, sha256: hash('declared source') }, { size: 15, sha256: hash('wrong source') }]) {
    const f = await fixture(t); let progress = 0;
    await assert.rejects(f.client.upload(f.source, { remotePath: '/tmp/declared.bin' }, () => { progress++; }, expected), error => {
      assert.equal(error.code, 'UPLOAD_SOURCE_MISMATCH'); assert.equal(error.transferId, undefined); assert.equal(error.message.includes(f.source), false); return true;
    });
    assert.equal(f.beginCount(), 0); assert.equal(progress, 0); assert.equal(f.chunks.length, 0);
  }
});

test('late caller expectation mutation cannot replace the source identity during async capture', async t => {
  const f = await fixture(t), expected = { size: f.bytes.length, sha256: hash('other bytes') };
  const pending = f.upload(expected);
  expected.sha256 = hash(f.bytes); expected.size = f.bytes.length;
  await assert.rejects(pending, { code: 'UPLOAD_SOURCE_MISMATCH' }); assert.equal(f.beginCount(), 0);
});

test('source path changes after the guard do not replace the immutable snapshot sent', async t => {
  const f = await fixture(t), changed = Buffer.from('replacement source after check');
  f.beforeBegin = () => writeFile(f.source, changed);
  await f.upload({ size: f.bytes.length, sha256: hash(f.bytes) });
  assert.deepEqual(await readFile(f.source), changed); assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
});

test('invalid API expectation is refused before reading a missing source or remote begin', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.upload(join(f.root, 'absent'), { remotePath: '/tmp/declared.bin' }, undefined, { size: '0', sha256: 'a'.repeat(64) }), { code: 'INVALID_UPLOAD_EXPECTATION' });
  assert.equal(f.beginCount(), 0);
});

test('bound upload unknown begin response retains ambiguity without retry or raw diagnostic', async t => {
  const f = await fixture(t); f.beginFailure = true;
  await assert.rejects(f.upload({ size: f.bytes.length, sha256: hash(f.bytes) }), error => {
    assert.equal(error.code, 'UPLOAD_RESULT_UNKNOWN'); assert.equal(error.message.includes('PRIVATE'), false); return true;
  });
  assert.equal(f.beginCount(), 1); assert.equal(f.chunks.length, 0);
});

test('CLI invalid expectation pair, syntax, help and non-upload use reject before helper, stdin or HTTP', async t => {
  const f = await fixture(t); let helpers = 0, stdin = 0, http = 0;
  globalThis.fetch = async () => { http++; assert.fail('No HTTP for invalid arguments'); };
  const input = { async *[Symbol.asyncIterator]() { stdin++; yield token; } };
  const prefix = ['--origin', 'https://fixture.invalid', '--cloudflared', f.source];
  const upload = ['upload', f.source, '/tmp/declared.bin'];
  const flags = ['--expect-size', '15', '--expect-sha256', hash(f.bytes)];
  const variants = [
    [...upload, '--expect-size', '15'], [...upload, '--expect-sha256', hash(f.bytes)],
    ...['-1', '01', '1.0', 'NaN', String(MAX_BYTES + 1), '9007199254740992'].map(size => [...upload, '--expect-size', size, '--expect-sha256', hash(f.bytes)]),
    [...upload, '--expect-size', '15', '--expect-sha256', 'A'.repeat(64)], ['targets', ...flags],
    ['resume-upload', transferId, f.source, '/tmp/declared.bin', ...flags], [...upload, ...flags, '--help'],
  ];
  for (const args of variants) {
    let stdout = '', stderr = '';
    const rc = await main([...prefix, ...args], input, { write: s => { stdout += s; } }, { write: s => { stderr += s; } }, () => { helpers++; return token; });
    assert.equal(rc, 1); assert.equal(stdout, ''); assert.equal(stderr.includes(token), false);
  }
  const rc = await main(['--origin', 'https://fixture.invalid', '--access-token-stdin', ...upload, '--expect-size', '15'], input, { write() {} }, { write() {} });
  assert.equal(rc, 1); assert.equal(helpers, 0); assert.equal(stdin, 0); assert.equal(http, 0);
});

test('CLI forwards a valid expectation to the same upload snapshot and refuses stale bytes', async t => {
  const f = await fixture(t); globalThis.fetch = f.send; let helpers = 0;
  const args = ['--origin', 'https://fixture.invalid', '--cloudflared', f.source, 'upload', f.source, '/tmp/declared.bin'];
  let stdout = '', stderr = '';
  const invoke = sha => main([...args, '--expect-size', String(f.bytes.length), '--expect-sha256', sha], null,
    { write: s => { stdout += s; } }, { write: s => { stderr += s; } }, () => { helpers++; return token; });
  assert.equal(await invoke(hash('stale source')), 1); assert.equal(f.beginCount(), 0); assert.equal(stdout, ''); assert.match(stderr, /UPLOAD_SOURCE_MISMATCH/);
  stderr = ''; assert.equal(await invoke(hash(f.bytes)), 0); assert.equal(f.beginCount(), 1); assert.equal(JSON.parse(stdout).id, requestId); assert.equal(helpers, 2);
  assert.equal((stdout + stderr).includes(token), false);
});
