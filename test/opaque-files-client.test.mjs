import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpaqueFilesClient, opaqueOperationKeyValid, opaqueUuidValid } from '../src/adapters/cli/opaque-files-client.mjs';
import { createOwnerHttpSession } from '../src/adapters/cli/owner-http-session.mjs';
import { main } from '../scripts/portal-files.mjs';

// Run on approved TEST only. Actual filesystem snapshots, raw fetch request
// bodies and client/CLI behavior; synthetic owner HTTP, never live approval.
const uuid = '12345678-1234-4234-8234-123456789abc';
const origin = 'https://fixture.example.test', accessToken = 'synthetic.owner.credential';
const key = 'opaque-client-fixture-20261104';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opaque-client-'));
  const bytes = Buffer.alloc(options.size ?? 385 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const file = join(root, 'synthetic.bin'); await writeFile(file, bytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [], chunks = [];
  const artifact = { uuid, state: options.initialState ?? 'staging', size: bytes.length, sha256: digest(bytes),
    expiresAt: Date.now() + 600_000, received: options.received ?? 0, sequence: options.sequence ?? 0 };
  async function fetch(url, init) {
    const path = new URL(url).pathname, headers = new Headers(init.headers);
    requests.push({ path, method: init.method, body: init.body, headers });
    assert.equal(init.redirect, 'error'); assert.equal(headers.get('cf-access-token'), accessToken);
    assert.equal(headers.get('origin'), origin);
    if (path === '/api/session') return json({ mode: 'access' });
    if (path === '/api/session/start') return json({ connected: true }, { 'Set-Cookie': '__Host-ssh_admin_session=' + 'a'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600' });
    assert.equal(headers.get('cookie'), '__Host-ssh_admin_session=' + 'a'.repeat(64));
    if (path === '/api/session/logout') return json({ connected: false });
    if (path === '/api/artifacts') {
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ['fileName', 'operationKey', 'sha256', 'size']);
      assert.equal(body.operationKey, key); assert.equal(body.fileName, 'synthetic.bin');
      assert.equal(body.size, bytes.length); assert.equal(body.sha256, digest(bytes));
      if (options.refuseBegin) return new Response(null, { status: 403 });
      if (options.beginLost) throw Error('synthetic response loss containing private marker');
      return json({ uuid: options.badBeginUuid ?? uuid });
    }
    if (path === '/api/artifacts/' + uuid) return json({ ...artifact, fileName: 'private-original-name', operations: [], privateMarker: 'MUST-NOT-ESCAPE' });
    if (path.startsWith('/api/artifacts/' + uuid + '/chunks/')) {
      assert.equal(init.method, 'PUT'); assert.ok(init.body instanceof Uint8Array);
      assert.equal(headers.get('content-type'), 'application/octet-stream');
      assert.ok(init.body.length <= 262144); assert.equal(headers.get('x-chunk-sha256'), digest(init.body));
      assert.equal(Number(path.split('/').at(-1)), artifact.sequence);
      if (options.chunkCode) return new Response(JSON.stringify({ error: options.chunkCode }), { status: 422, headers: { 'Content-Type': 'application/json' } });
      chunks.push(Buffer.from(init.body)); artifact.received += init.body.length; artifact.sequence++;
      if (options.chunkLost) throw Error('synthetic chunk response loss containing private marker');
      return json({ uuid, sequence: artifact.sequence + (options.badAck ? 1 : 0), received: artifact.received });
    }
    if (path === '/api/artifacts/' + uuid + '/complete') {
      assert.equal(init.method, 'POST'); assert.equal(init.body, '{}'); artifact.state = 'ready';
      if (options.completeLost) throw Error('synthetic completion response loss');
      return json({ uuid });
    }
    assert.fail('Unexpected client request: ' + path);
  }
  const client = createOpaqueFilesClient({ origin, accessToken, fetch });
  t.after(() => client.close());
  await client.connect();
  return { root, file, bytes, client, requests, chunks, artifact, fetch };
}

test('opaque upload sends exact385KiB as bounded raw bytes and returns only the completed UUID', async t => {
  const f = await fixture(t), progress = [];
  const result = await f.client.upload(f.file, key, record => progress.push(record));
  assert.deepEqual(result, { uuid }); assert.deepEqual(progress, [{ uuid, phase: 'staging' }]);
  assert.deepEqual(f.chunks.map(bytes => bytes.length), [262144, 132096]);
  assert.deepEqual(Buffer.concat(f.chunks), f.bytes);
  assert.equal(f.requests.filter(r => r.path === '/api/artifacts').length, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 1);
  assert.equal(f.artifact.state, 'ready');
});

// Delta selector: --test-name-pattern=^server cause:
async function causeFixture(t, reply) {
  const calls = [];
  const session = createOwnerHttpSession({ origin, accessToken, fetch: async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, method: init.method });
    if (path === '/api/session') return json({ mode: 'access' });
    if (path === '/api/session/start') return json({ connected: true }, { 'Set-Cookie': '__Host-ssh_admin_session=' + 'b'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600' });
    if (path === '/api/session/logout') return json({ connected: false });
    return reply(init);
  } });
  t.after(() => session.close()); await session.connect();
  return { session, calls };
}

test('server cause: shared session preserves typed causes without changing legacy refusal codes', async t => {
  for (const [serverCode, status] of [['ARTIFACT_QUOTA', 507], ['ARTIFACT_NOT_FOUND', 404], ['CHUNK_HASH_MISMATCH', 422], ['ARTIFACT_HASH_MISMATCH', 422]]) {
    const f = await causeFixture(t, () => new Response(JSON.stringify({ error: serverCode }), { status, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(f.session.json('/api/refused', {}), error => error.code === 'PORTAL_REQUEST_REFUSED' && error.status === status && error.serverCode === serverCode && error.message === 'PORTAL_REQUEST_REFUSED');
    assert.equal(f.calls.filter(call => call.path === '/api/refused').length, 1);
  }
});

test('server cause: malformed JSON or non-JSON error responses retain the original refusal only', async t => {
  for (const [body, type] of [['{"error":', 'application/json'], ['{"error":"ARTIFACT_QUOTA"}', 'text/plain'], ['<html>private path /home/private and token</html>', 'text/html']]) {
    const f = await causeFixture(t, () => new Response(body, { status: 409, headers: { 'Content-Type': type } }));
    await assert.rejects(f.session.json('/api/refused', {}), error => error.code === 'PORTAL_REQUEST_REFUSED' && error.status === 409 && !Object.hasOwn(error, 'serverCode') && !error.message.includes('private'));
  }
});

test('server cause: only a3..64 uppercase ASCII code is retained, never arbitrary error values', async t => {
  for (const suffix of ['\n', '\r', '\r\n']) {
    assert.equal(opaqueUuidValid(uuid + suffix), false);
    assert.equal(opaqueOperationKeyValid('a'.repeat(16) + suffix), false);
  }
  for (const error of ['ab', 'A'.repeat(65), 'ERR\n', 'ERR\r', 'ERR\r\n', '/home/private/token', 'PASSWORD=private-marker', 'LOWER_case', { code: 'ARTIFACT_QUOTA' }, ['ARTIFACT_QUOTA'], null]) {
    const f = await causeFixture(t, () => new Response(JSON.stringify({ error }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(f.session.json('/api/refused', {}), value => value.code === 'PORTAL_REQUEST_REFUSED' && !Object.hasOwn(value, 'serverCode'));
  }
  for (const serverCode of ['ERR', 'A'.repeat(64), 'CODE_200']) {
    const f = await causeFixture(t, () => new Response(JSON.stringify({ error: serverCode }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(f.session.json('/api/refused', {}), value => value.serverCode === serverCode);
  }
});

test('server cause: the existing1MiB JSON body limit also bounds optional refusal causes', async t => {
  let cancelled = false, produced = 0;
  const f = await causeFixture(t, () => new Response(new ReadableStream({
    pull(controller) { produced++; controller.enqueue(Buffer.alloc(256 * 1024, 120)); if (produced === 32) controller.close(); },
    cancel() { cancelled = true; },
  }), { status: 507, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(f.session.json('/api/refused', {}), error => error.code === 'PORTAL_REQUEST_REFUSED' && error.status === 507 && !Object.hasOwn(error, 'serverCode'));
  assert.ok(produced < 32); assert.equal(cancelled, true);
});

test('server cause:401 remains owner reauthentication and never accepts a contradictory server cause', async t => {
  let cancelled = false;
  const f = await causeFixture(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"error":"ARTIFACT_QUOTA"}')); }, cancel() { cancelled = true; },
  }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(f.session.json('/api/refused', {}), error => error.code === 'OWNER_REAUTH_REQUIRED' && error.status === 401 && !Object.hasOwn(error, 'serverCode'));
  assert.equal(cancelled, true);
});

test('server cause: network uncertainty retains read/write distinctions without inventing a cause', async t => {
  const f = await causeFixture(t, () => { throw Error('private stack path /home/private'); });
  await assert.rejects(f.session.json('/api/refused', {}), error => error.code === 'PORTAL_RESULT_UNKNOWN' && !Object.hasOwn(error, 'serverCode'));
  await assert.rejects(f.session.json('/api/refused'), error => error.code === 'PORTAL_READ_FAILED' && !Object.hasOwn(error, 'serverCode'));
  assert.equal(f.calls.filter(call => call.path === '/api/refused').length, 2);
});

test('server cause: opaque upload and CLI stderr retain a safe chunk cause with the same UUID only', async t => {
  const f = await fixture(t, { chunkCode: 'CHUNK_HASH_MISMATCH' }); let stdout = '', stderr = '';
  const code = await main(['--origin', origin, '--cloudflared', join(f.root, 'cloudflared'), 'upload', '--file', f.file, '--operation-key', key],
    { write: value => { stdout += value; } }, { write: value => { stderr += value; } }, () => accessToken, {},
    options => createOpaqueFilesClient({ ...options, fetch: f.fetch }));
  assert.equal(code, 1); assert.equal(stdout, '');
  const last = JSON.parse(stderr.trim().split('\n').at(-1));
  assert.deepEqual(last, { error: 'PORTAL_REQUEST_REFUSED', serverCode: 'CHUNK_HASH_MISMATCH', uuid, phase: 'chunks', state: 'staging', received: 0, sequence: 0 });
  assert.doesNotMatch(stderr, /synthetic\.bin|synthetic\.owner\.credential|MUST-NOT-ESCAPE/);
  assert.equal(f.requests.filter(r => r.path.includes('/chunks/')).length, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 0);
});

test('opaque status projects safe metadata for the same UUID across declared states', async t => {
  const f = await fixture(t);
  for (const state of ['staging', 'ready', 'expired', 'consuming', 'moved', 'removed']) {
    f.artifact.state = state; if (state === 'ready') f.artifact.received = f.artifact.size;
    const result = await f.client.status(uuid);
    assert.deepEqual(Object.keys(result), ['uuid', 'state', 'size', 'sha256', 'expiresAt', 'received', 'sequence']);
    assert.equal(result.uuid, uuid); assert.equal(result.state, state);
    assert.doesNotMatch(JSON.stringify(result), /MUST-NOT-ESCAPE|private-original-name|operations/);
  }
  await assert.rejects(f.client.status('a'.repeat(48)), { code: 'INVALID_ARTIFACT_UUID' });
  const hash = f.artifact.sha256;
  for (const suffix of ['\n', '\r', '\r\n']) {
    f.artifact.sha256 = hash + suffix;
    await assert.rejects(f.client.status(uuid), { code: 'INVALID_ARTIFACT_RESPONSE' });
  }
});

test('existing ready artifact yields UUID without chunk or completion replay', async t => {
  const f = await fixture(t, { initialState: 'ready', received: 385 * 1024, sequence: 2 });
  assert.deepEqual(await f.client.upload(f.file, key), { uuid });
  assert.equal(f.chunks.length, 0); assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 0);
});

test('zero-byte snapshot completes without fabricated chunk bytes', async t => {
  const f = await fixture(t, { size: 0 });
  assert.deepEqual(await f.client.upload(f.file, key), { uuid });
  assert.equal(f.chunks.length, 0); assert.equal(f.artifact.received, 0); assert.equal(f.artifact.sequence, 0);
  assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 1);
});

test('owner refusal and malformed progress metadata never send file chunks', async t => {
  const a = await fixture(t, { refuseBegin: true });
  await assert.rejects(a.client.upload(a.file, key), { code: 'PORTAL_REQUEST_REFUSED' }); assert.equal(a.chunks.length, 0);
  const b = await fixture(t); b.artifact.received = b.artifact.size + 1;
  await assert.rejects(b.client.upload(b.file, key), { code: 'INVALID_ARTIFACT_RESPONSE' }); assert.equal(b.chunks.length, 0);
});

test('existing partial artifact is observed and never silently resumed', async t => {
  const f = await fixture(t, { received: 1, sequence: 1 });
  await assert.rejects(f.client.upload(f.file, key), error => error.code === 'ARTIFACT_ALREADY_STAGING' && error.uuid === uuid && error.progress.received === 1);
  assert.equal(f.chunks.length, 0); assert.equal(f.requests.filter(r => r.path === '/api/artifacts').length, 1);
});

test('begin response loss preserves uncertainty without a replacement allocation', async t => {
  const f = await fixture(t, { beginLost: true });
  await assert.rejects(f.client.upload(f.file, key), error => error.code === 'PORTAL_RESULT_UNKNOWN' && error.phase === 'begin' && error.uuid === undefined);
  assert.equal(f.requests.filter(r => r.path === '/api/artifacts').length, 1); assert.equal(f.chunks.length, 0);
});

test('lost chunk response observes the same UUID and sends no retry or complete', async t => {
  const f = await fixture(t, { chunkLost: true });
  await assert.rejects(f.client.upload(f.file, key), error => error.code === 'PORTAL_RESULT_UNKNOWN' && error.uuid === uuid && error.progress.received === 262144 && error.progress.sequence === 1);
  assert.equal(f.chunks.length, 1); assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 0);
  assert.equal(f.requests.filter(r => r.path === '/api/artifacts').length, 1);
});

test('lost completion response reports same ready UUID as progress without replay or false success', async t => {
  const f = await fixture(t, { completeLost: true });
  await assert.rejects(f.client.upload(f.file, key), error => error.code === 'PORTAL_RESULT_UNKNOWN' && error.uuid === uuid && error.progress.state === 'ready');
  assert.equal(f.chunks.length, 2); assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 1);
});

test('wrong acknowledgement cannot produce a completed UUID or skip a byte range', async t => {
  const f = await fixture(t, { badAck: true });
  await assert.rejects(f.client.upload(f.file, key), { code: 'INVALID_ARTIFACT_ACK' });
  assert.equal(f.chunks.length, 1); assert.equal(f.requests.filter(r => r.path.endsWith('/complete')).length, 0);
});

test('invalid UUID and mismatched whole hash fail before sending file chunks', async t => {
  const a = await fixture(t, { badBeginUuid: 'a'.repeat(48) });
  await assert.rejects(a.client.upload(a.file, key), { code: 'INVALID_ARTIFACT_RESPONSE' }); assert.equal(a.chunks.length, 0);
  const b = await fixture(t); b.artifact.sha256 = '0'.repeat(64);
  await assert.rejects(b.client.upload(b.file, key), { code: 'ARTIFACT_SOURCE_MISMATCH' }); assert.equal(b.chunks.length, 0);
});

test('CLI upload emits only one UUID JSON line and never prints source bytes, filename or credential', async t => {
  const f = await fixture(t); let stdout = '', stderr = '', credentials = 0;
  const code = await main(['--origin', origin, '--cloudflared', join(f.root, 'cloudflared'), 'upload', '--file', f.file, '--operation-key', key],
    { write: text => { stdout += text; } }, { write: text => { stderr += text; } }, () => { credentials++; return accessToken; }, {},
    options => createOpaqueFilesClient({ ...options, fetch: f.fetch }));
  assert.equal(code, 0); assert.equal(stdout, JSON.stringify({ uuid }) + '\n'); assert.equal(credentials, 1);
  assert.doesNotMatch(stdout + stderr, /synthetic\.bin|synthetic\.owner\.credential|MUST-NOT-ESCAPE|base64/);
  assert.deepEqual(JSON.parse(stderr), { uuid, phase: 'staging' });
});

test('CLI lost response emits no success stdout and only bounded same-UUID progress on stderr', async t => {
  const f = await fixture(t, { chunkLost: true }); let stdout = '', stderr = '';
  const code = await main(['--origin', origin, '--cloudflared', join(f.root, 'cloudflared'), 'upload', '--file', f.file, '--operation-key', key],
    { write: text => { stdout += text; } }, { write: text => { stderr += text; } }, () => accessToken, {},
    options => createOpaqueFilesClient({ ...options, fetch: f.fetch }));
  assert.equal(code, 1); assert.equal(stdout, '');
  const last = JSON.parse(stderr.trim().split('\n').at(-1));
  assert.deepEqual(last, { error: 'PORTAL_RESULT_UNKNOWN', uuid, phase: 'chunks', state: 'staging', received: 262144, sequence: 1 });
  assert.doesNotMatch(stderr, /private marker|synthetic\.bin|synthetic\.owner\.credential|MUST-NOT-ESCAPE/);
  assert.equal(f.chunks.length, 1);
});

test('CLI rejects missing stable key and invalid UUID before credential or network access', async t => {
  const f = await fixture(t); let count = 0;
  for (const args of [['upload', '--file', f.file], ['upload', '--file', f.file, '--operation-key', 'a'.repeat(15)], ['status', 'a'.repeat(48)]]) {
    let stdout = '', stderr = '';
    assert.equal(await main(['--origin', origin, ...args], { write: text => { stdout += text; } }, { write: text => { stderr += text; } }, () => { count++; return accessToken; }), 1);
    assert.equal(stdout, ''); assert.match(stderr, /INVALID_ARGUMENTS|INVALID_ARTIFACT_UUID|INVALID_OPERATION_KEY/);
  }
  assert.equal(count, 0);
});

test('operation-key grammar matches the public16..128 ASCII contract at both boundaries', () => {
  for (const value of ['a'.repeat(16), 'a'.repeat(128), '_'.repeat(16), '.:-_'.repeat(4)]) assert.equal(opaqueOperationKeyValid(value), true);
  for (const value of ['', 'a'.repeat(15), 'a'.repeat(129), '가'.repeat(16), 'a'.repeat(16) + '\n', 'a'.repeat(15) + '/', null]) assert.equal(opaqueOperationKeyValid(value), false);
});

test('client tar and zip contain identical verified sources and run without npm dependencies', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'opaque-client-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = promisify(execFile), python = process.platform === 'win32' ? 'python' : 'python3';
  const { stdout } = await run(python, ['scripts/package-client.py', '--output', join(root, 'dist')], { cwd: process.cwd() });
  const built = JSON.parse(stdout); assert.equal(built.version, '2.0.0');
  const verify = `import hashlib,json,pathlib,sys,tarfile,zipfile
root=pathlib.Path(sys.argv[1]); prefix='ssh-approval-portal-client-2.0.0/'
with tarfile.open(root/'dist'/(prefix[:-1]+'.tar.gz'),'r:gz') as archive:
    tar={m.name:archive.extractfile(m).read() for m in archive.getmembers()}
    assert all(name.startswith(prefix) and '..' not in pathlib.PurePosixPath(name).parts for name in tar)
    archive.extractall(root/'unpacked',filter='data')
with zipfile.ZipFile(root/'dist'/(prefix[:-1]+'.zip')) as archive:
    zipped={name:archive.read(name) for name in archive.namelist()}
assert tar==zipped
manifest=json.loads(tar[prefix+'client-manifest.json'])
assert manifest['version']=='2.0.0'
for item in manifest['files']:
    data=tar[prefix+item['path']]
    assert len(data)==item['size'] and hashlib.sha256(data).hexdigest()==item['sha256']
assert len(tar)==len(manifest['files'])+1
assert not any('/node_modules/' in name or name.endswith('/.env') or name.endswith('/app.mjs') for name in tar)
metadata=json.loads(tar[prefix+'package.json'])
assert metadata['version']=='2.0.0' and metadata['dependencies']=={} and metadata['engines']['node']=='>=24.2.0 <25'
print(json.dumps({'files':len(tar),'manifestVerified':True,'tarZipEqual':True}))
`;
  const verified = JSON.parse((await run(python, ['-c', verify, root])).stdout);
  assert.equal(verified.manifestVerified, true); assert.equal(verified.tarZipEqual, true);
  const environment = { ...process.env }; delete environment.NODE_PATH;
  const help = await run(process.execPath, ['scripts/portal-files.mjs', '--help'],
    { cwd: join(root, 'unpacked', 'ssh-approval-portal-client-2.0.0'), env: environment });
  assert.match(help.stdout, /file client2\.0\.0/); assert.equal(help.stderr, '');
});
