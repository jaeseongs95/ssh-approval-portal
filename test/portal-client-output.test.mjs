import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { main } from '../scripts/portal-client.mjs';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
import { OUTPUT_PAGE_BYTES } from '../src/contracts/ports.mjs';

const origin = 'https://owner.example.test', token = 'synthetic.header.signature';
const id = 'a'.repeat(48), outputId = 'b'.repeat(48);
const hash = text => createHash('sha256').update(text).digest('hex');
const body = '한글🙂\n', snapshot = JSON.stringify({ failed: false, texts: [body] });
const capture = { version: 1, captureSource: 'redacted-adapter-outcome', sshCompleteness: 'unknown' };
const originalFetch = globalThis.fetch;
function descriptor() {
  return { ...capture, id: outputId, executionId: id, state: 'ready', expiresAt: Date.now() + 3600000,
    bytes: Buffer.byteLength(body), snapshotBytes: Buffer.byteLength(snapshot), sha256: hash(snapshot) };
}
function fixture(t, { patchJob, patchRef, patchPage, pageText, failPage } = {}) {
  const ref = { ...descriptor(), ...patchRef }, calls = [];
  const job = { id, kind: 'command', state: 'completed', result: { structuredContent: { output: ref } }, ...patchJob };
  const send = async (url, options) => {
    const u = new URL(url); calls.push({ path: u.pathname, query: u.search, method: options.method });
    assert.equal(options.headers['cf-access-token'], token);
    if (u.pathname === '/api/session') return Response.json({ mode: 'access' });
    if (u.pathname === '/api/session/start') return Response.json({ connected: true }, { headers: { 'Set-Cookie': '__Host-ssh_admin_session=' + 'f'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60' } });
    if (u.pathname === '/api/session/logout') return Response.json({ connected: false });
    if (u.pathname === '/api/' + id) return Response.json(job);
    assert.equal(u.pathname, '/api/outputs/' + outputId);
    if (failPage) { if (typeof failPage === 'number') return Response.json({ private: 'REFUSED_BODY_MUST_NOT_ESCAPE' }, { status: failPage }); throw Error('REFUSED_BODY_MUST_NOT_ESCAPE ' + token); }
    const format = u.searchParams.get('format'), full = format === 'json' ? snapshot : body;
    const offsetBytes = Number(u.searchParams.get('offset'));
    const text = pageText === undefined ? full : pageText;
    return Response.json({ text, ...capture, outputId, executionId: id, format, offsetBytes,
      bytes: Buffer.byteLength(text), nextOffset: offsetBytes + Buffer.byteLength(text), eof: offsetBytes + Buffer.byteLength(text) === Buffer.byteLength(full),
      totalBytes: Buffer.byteLength(full), sha256: hash(full), expiresAt: ref.expiresAt, ...patchPage });
  };
  globalThis.fetch = send; t.after(() => { globalThis.fetch = originalFetch; });
  return { calls, job, ref, send };
}
async function invoke(args, mode = ['--cloudflared', process.execPath]) {
  let stdout = '', stderr = '', helperCalls = 0;
  const code = await main(['--origin', origin, ...mode, ...args], Readable.from([token + '\n']),
    { write: value => { stdout += value; } }, { write: value => { stderr += value; } }, () => { helperCalls++; return token; });
  assert.equal((stdout + stderr).includes(token), false);
  return { code, stdout, stderr, helperCalls, value: stdout ? JSON.parse(stdout) : null };
}
const pageCalls = f => f.calls.filter(c => c.path.startsWith('/api/outputs/'));
const effectCalls = f => f.calls.filter(c => c.method !== 'GET' && !['/api/session/start', '/api/session/logout'].includes(c.path));

test('explicit output reads whole text and JSON with distinct format hashes and preserved body', async t => {
  const f = fixture(t, { patchPage: { unexpectedPrivateField: token } });
  for (const [format, full] of [['text', body], ['json', snapshot]]) {
    const r = await invoke(['output', id, '--format', format]);
    assert.equal(r.code, 0, 'stored output command must return its body');
    assert.equal(r.value.text, full); assert.equal(r.value.outputId, outputId); assert.equal(r.value.executionId, id);
    assert.equal(r.value.bytes, Buffer.byteLength(full)); assert.equal(r.value.sha256, hash(full));
    assert.equal(r.value.wholeSha256Verified, true); assert.equal(r.value.sshCompleteness, 'unknown');
    assert.equal(r.helperCalls, 1);
  }
  assert.notEqual(hash(body), f.ref.sha256, 'descriptor hash belongs to JSON, not text');
  assert.equal(pageCalls(f).length, 2); assert.equal(effectCalls(f).length, 0);
});
test('explicit UTF8 pages preserve cursor and never claim a partial-format whole hash', async t => {
  const first = fixture(t, { pageText: '한글' });
  const a = await invoke(['output', id, '--limit', '7']);
  assert.equal(a.code, 0); assert.equal(a.value.text, '한글'); assert.equal(a.value.bytes, 6);
  assert.equal(a.value.nextOffset, 6); assert.equal(a.value.eof, false); assert.equal(a.value.wholeSha256Verified, false);
  assert.equal(pageCalls(first).length, 1); assert.equal(effectCalls(first).length, 0);
});
test('a later UTF8 page and an empty failed command output remain readable without replay', async t => {
  fixture(t, { pageText: '🙂\n' });
  const r = await invoke(['output', id, '--offset', '6', '--limit', '7']);
  assert.equal(r.code, 0); assert.equal(r.value.nextOffset, 11); assert.equal(r.value.eof, true); assert.equal(r.value.wholeSha256Verified, false);
  const empty = fixture(t, { patchJob: { state: 'failed' }, patchRef: { bytes: 0 }, pageText: '', patchPage: { totalBytes: 0, bytes: 0, nextOffset: 0, eof: true, sha256: hash('') } });
  const e = await invoke(['output', id], ['--access-token-stdin']);
  assert.equal(e.code, 0); assert.equal(e.value.text, ''); assert.equal(e.value.wholeSha256Verified, true);
  assert.equal(e.helperCalls, 0); assert.equal(effectCalls(empty).length, 0);
});
test('invalid output identifiers ranges formats and output-only flags fail before authentication', async t => {
  const f = fixture(t);
  for (const args of [['output', 'bad'], ['output', id, '--offset', '-1'], ['output', id, '--offset', '1.5'],
    ['output', id, '--offset', ''], ['output', id, '--offset', '9007199254740992'], ['output', id, '--limit', '3'],
    ['output', id, '--limit', String(OUTPUT_PAGE_BYTES + 1)], ['output', id, '--format', 'yaml'],
    ['output', id, '--confirm'], ['output', id, '--target', 'default'], ['output', id, '--help'], ['status', id, '--offset', '0']]) {
    const r = await invoke(args); assert.equal(r.code, 1); assert.equal(r.helperCalls, 0); assert.equal(r.stdout, '');
  }
  assert.equal(f.calls.length, 0);
});
test('unready stale or mismatched output references never fetch body or mutate work', async t => {
  for (const options of [{ patchJob: { state: 'pending' } }, { patchJob: { state: 'denied' } }, { patchJob: { state: 'unknown' } },
    { patchJob: { kind: 'upload' } }, { patchRef: { executionId: 'c'.repeat(48) } }, { patchRef: { id: 'bad' } },
    { patchRef: { state: 'expired' } }, { patchRef: { expiresAt: 1 } }, { patchRef: { version: 2 } },
    { patchRef: { captureSource: 'raw-ssh' } }, { patchRef: { snapshotBytes: -1 } }, { patchRef: { sha256: [hash(snapshot)] } }]) {
    const f = fixture(t, options), r = await invoke(['output', id]);
    assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.equal(pageCalls(f).length, 0); assert.equal(effectCalls(f).length, 0);
    assert.equal(JSON.parse(r.stderr).requestId, id);
  }
});
test('malformed foreign or inconsistent pages refuse their body and retain validated IDs', async t => {
  for (const patchPage of [{ outputId: 'c'.repeat(48) }, { executionId: 'c'.repeat(48) }, { format: 'json' }, { offsetBytes: 1 },
    { bytes: 1 }, { nextOffset: 1 }, { totalBytes: 100 }, { eof: false }, { expiresAt: 1 }, { sha256: '0'.repeat(64) },
    { text: 'REFUSED_BODY_MUST_NOT_ESCAPE' }, { text: '\ud800' }, { version: 2 }, { sshCompleteness: 'complete' }]) {
    const f = fixture(t, { patchPage }), r = await invoke(['output', id]);
    assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr.includes('REFUSED_BODY_MUST_NOT_ESCAPE'), false);
    const error = JSON.parse(r.stderr); assert.equal(error.requestId, id); assert.equal(error.outputId, outputId);
    assert.equal(pageCalls(f).length, 1); assert.equal(effectCalls(f).length, 0);
  }
});
test('revocation refusal and read failure expose only public errors with no retry', async t => {
  for (const failPage of [401, 409, true]) {
    const f = fixture(t, { failPage }), r = await invoke(['output', id]);
    assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr.includes('REFUSED_BODY_MUST_NOT_ESCAPE'), false);
    assert.equal(pageCalls(f).length, 1); assert.equal(effectCalls(f).length, 0);
    const error = JSON.parse(r.stderr); assert.equal(error.requestId, id); assert.equal(error.outputId, outputId);
  }
});
test('embedded client rejects invalid options without an output HTTP request', async t => {
  const f = fixture(t), client = createPortalClient({ origin, accessToken: token, fetch: f.send });
  await client.connect();
  try {
    assert.equal(typeof client.output, 'function', 'stored output public client method must exist');
    for (const options of [null, [], { offsetBytes: -1 }, { maxBytes: 3 }, { format: 'yaml' }, { extra: true }]) {
      await assert.rejects(client.output(id, options), { code: 'INVALID_OUTPUT_OPTIONS' });
    }
    assert.equal(pageCalls(f).length, 0); assert.equal(f.calls.some(c => c.path === '/api/' + id), false);
  } finally { await client.close(); }
});
test('partial page hashes must be strings even when a whole-format hash cannot be computed', async t => {
  const f = fixture(t, { pageText: '한글', patchPage: { sha256: [hash(body)] } });
  const r = await invoke(['output', id, '--limit', '7']);
  assert.equal(r.code, 1, 'non-string partial hash must refuse the body'); assert.equal(r.stdout, '');
  assert.equal(pageCalls(f).length, 1); assert.equal(JSON.parse(r.stderr).outputId, outputId);
});
