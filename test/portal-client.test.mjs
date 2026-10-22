import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApplication } from '../app.mjs';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';
import { main } from '../scripts/portal-client.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owner-cli-http-'));
  const origin = 'https://owner.test', issuer = 'https://fixture.cloudflareaccess.com', aud = 'a'.repeat(64);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const events = [], calls = [], effects = [], remote = new Map(), staged = new Map();
  const app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => assert.fail('No command execution'),
    audit: event => events.push(event), transferRoot: join(root, 'store'), uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-maintenance', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_ADMIN_ORIGIN: origin,
      BRIDGE_ADMIN_AUTH_MODE: 'access', BRIDGE_ACCESS_TEAM_DOMAIN: issuer, BRIDGE_ACCESS_AUD: aud, BRIDGE_ACCESS_OWNER_EMAILS: 'owner@example.test' },
    accessKeySet: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'fixture' }] }) });
  const transfers = app.targets.select('default').transfers;
  // Only remote SSH/helper I/O is synthetic. Real queue, transfers, artifact store,
  // file API, signed JWT verification, app sessions and local filesystem remain.
  transfers.transport = { connect: async () => ({
    upload: async (source, path) => { const parts = []; for await (const b of source) parts.push(Buffer.from(b)); staged.set(path.split('/').at(-1).slice(0, -5), Buffer.concat(parts)); },
    download: async (path, destination) => { destination.end(staged.get(path.split('/').at(-1).slice(0, -5))); },
    call: async (_command, op) => {
      if (op.action === 'publish') {
        if (!op.overwrite && remote.has(op.remotePath)) return { exitCode: 1, stdout: '{}' };
        const bytes = staged.get(op.id); assert.equal(hash(bytes), op.sha256); assert.equal(bytes.length, op.size);
        remote.set(op.remotePath, bytes); effects.push({ kind: 'upload', path: op.remotePath });
        return { exitCode: 0, stdout: JSON.stringify({ size: bytes.length, sha256: hash(bytes) }) };
      }
      if (op.action === 'snapshot') {
        const bytes = remote.get(op.remotePath); assert.ok(bytes);
        staged.set(op.id, Buffer.from(bytes)); effects.push({ kind: 'download', path: op.remotePath });
        return { exitCode: 0, stdout: JSON.stringify({ size: bytes.length, sha256: hash(bytes) }) };
      }
      assert.equal(op.action, 'cleanup'); staged.delete(op.id); return { exitCode: 0, stdout: '{}' };
    },
  }) };
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const loopback = 'http://127.0.0.1:' + app.adminHttp.address().port;
  const jwt = (subject = 'alice', email = 'owner@example.test', expiration = '5m') => new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer(issuer).setAudience(aud).setSubject(subject).setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  const token = await jwt();
  const raw = (path, body, extra = {}) => fetch(loopback + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-jwt-assertion': token, Origin: origin, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    const headers = new Headers(options.headers);
    const credential = headers.get('cf-access-token'); headers.delete('cf-access-token');
    headers.set('cf-access-jwt-assertion', credential); // Synthetic Cloudflare edge forwarding.
    calls.push({ path: new URL(url).pathname, method: options.method });
    return fetch(loopback + new URL(url).pathname + new URL(url).search, { ...options, headers });
  };
  const clients = [];
  const client = (options = {}) => { const value = createPortalClient({ origin, accessToken: token, fetch: send, ...options }); clients.push(value); return value; };
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.close())); await app.close();
    assert.ok(root.startsWith(join(tmpdir(), 'owner-cli-http-'))); await rm(root, { recursive: true, force: true });
  });
  return { root, origin, loopback, app, raw, send, client, token, jwt, calls, effects, remote, events };
}

test('owner CLI moves exact multi-chunk and empty bytes only after explicit approval, then saves the same prepared download', async t => {
  const f = await fixture(t), c = f.client(); await c.connect();
  const bytes = Buffer.alloc(CHUNK_BYTES + 9); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const source = join(f.root, 'source.bin'); await writeFile(source, bytes);
  assert.equal((await c.targets()).defaultTarget, 'default');
  let handle;
  const up = await c.upload(source, { remotePath: '/tmp/exact.bin' }, value => { handle = value.transferId; });
  assert.equal(up.state, 'pending'); assert.equal(up.operation.size, bytes.length); assert.equal(up.operation.sha256, hash(bytes));
  assert.deepEqual(f.effects, []); assert.equal((await c.transfer(handle)).job.id, up.id);
  await assert.rejects(c.decide(up.id, 'approve', false), { code: 'EXPLICIT_OWNER_DECISION_REQUIRED' });
  assert.equal((await c.decide(up.id, 'approve', true)).state, 'completed');
  const approvalCalls = f.calls.filter(x => x.path.endsWith('/approve')).length;
  assert.equal((await c.decide(up.id, 'approve', true)).state, 'completed');
  assert.equal(f.calls.filter(x => x.path.endsWith('/approve')).length, approvalCalls);
  assert.deepEqual(f.remote.get('/tmp/exact.bin'), bytes); assert.equal(f.effects.length, 1);
  const down = await c.requestDownload({ remotePath: '/tmp/exact.bin' }); assert.equal(down.state, 'pending');
  const local = join(f.root, 'saved.bin');
  await assert.rejects(c.save(down.id, local), { code: 'DOWNLOAD_NOT_READY' }); assert.equal(f.effects.length, 1);
  await c.decide(down.id, 'approve', true); assert.equal(f.effects.length, 2);
  assert.equal((await c.save(down.id, local)).state, 'saved'); assert.deepEqual(await readFile(local), bytes);
  await assert.rejects(c.save(down.id, local), { code: 'EEXIST' }); assert.deepEqual(await readFile(local), bytes); assert.equal(f.effects.length, 2);
  await writeFile(source, Buffer.alloc(0));
  const empty = await c.upload(source, { remotePath: '/tmp/empty' }); await c.decide(empty.id, 'approve', true);
  assert.deepEqual(f.remote.get('/tmp/empty'), Buffer.alloc(0));
  for (const secret of [f.token, '__Host-ssh_admin_session', 'ticket=']) assert.equal(JSON.stringify([up, down, f.events]).includes(secret), false);
});

test('new file routes require valid owner proof AND its own session AND mutation Origin', async t => {
  const f = await fixture(t);
  const meta = { remotePath: '/tmp/x', fileName: 'x', size: 1, sha256: hash(Buffer.from('x')) };
  assert.equal((await f.raw('/api/files/uploads', meta)).status, 401);
  const login = await f.raw('/api/session/start', {}), cookie = login.headers.get('set-cookie').split(';')[0]; await login.body.cancel();
  for (const [extra, expected] of [[{ Cookie: cookie, 'cf-access-jwt-assertion': '' }, 401], [{ Cookie: cookie, 'cf-access-jwt-assertion': await f.jwt('alice', 'other@example.test') }, 401], [{ Cookie: cookie, 'cf-access-jwt-assertion': await f.jwt('bob') }, 401], [{ Cookie: cookie, Origin: 'https://evil.test' }, 403]]) {
    const r = await f.raw('/api/files/uploads', meta, extra); assert.equal(r.status, expected); await r.body.cancel();
  }
  const c = f.client(); await c.connect();
  await f.raw('/api/session/logout', {}, { Cookie: cookie });
  assert.equal((await c.targets()).defaultTarget, 'default', 'browser logout must not revoke the independently started CLI session');
  const expired = f.client({ accessToken: await f.jwt('alice', 'owner@example.test', Math.floor(Date.now() / 1000) - 30) });
  await assert.rejects(expired.connect(), { code: 'OWNER_REAUTH_REQUIRED' });
  assert.equal(f.effects.length, 0); assert.equal(f.app.queue.listAll().length, 0);
});

test('owner file boundary rejects malformed fields/chunks/targets and reuses the existing staging sequence rules', async t => {
  const f = await fixture(t), login = await f.raw('/api/session/start', {}), headers = { Cookie: login.headers.get('set-cookie').split(';')[0] }; await login.body.cancel();
  const meta = { remotePath: '/tmp/x', fileName: 'x', size: 1, sha256: hash(Buffer.from('x')) };
  for (const body of [{ ...meta, extra: true }, { ...meta, elevate: 'true' }, { ...meta, target: 'missing' }, { ...meta, size: -1 }, { ...meta, sha256: 'bad' }]) {
    const r = await f.raw('/api/files/uploads', body, headers); assert.equal(r.status, 409); await r.body.cancel();
  }
  const begun = await f.raw('/api/files/uploads', meta, headers), handle = (await begun.json()).transferId;
  const path = '/api/files/uploads/' + handle;
  for (const body of [{ sequence: 0, data: 'eA' }, { sequence: 2, data: 'eA==' }, { sequence: 0, data: '', extra: true }]) {
    const r = await f.raw(path + '/chunks', body, headers); assert.equal(r.status, 409); await r.body.cancel();
  }
  for (let i = 0; i < 2; i++) { const r = await f.raw(path + '/chunks', { sequence: 0, data: 'eA==' }, headers); assert.deepEqual(await r.json(), { sequence: 1, received: 1 }); }
  const status = await f.raw(path, undefined, headers), transfer = (await status.json()).transfer;
  assert.equal(transfer.received, 1); assert.equal(transfer.sequence, 1); assert.equal(Object.hasOwn(transfer, 'path'), false);
  assert.equal((await f.raw(path + '?x=1', undefined, headers)).status, 409);
  const first = await f.raw(path + '/finish', {}, headers); assert.equal((await first.json()).state, 'pending');
  const second = await f.raw(path + '/finish', {}, headers); assert.equal(second.status, 409);
  assert.equal(f.app.queue.listAll().length, 1); assert.equal(f.effects.length, 0);
});

test('lost finish and approval ACKs return known handles without a repeated POST or remote effect', async t => {
  const f = await fixture(t); let dropFinish = true, dropApprove = true;
  const c = f.client({ fetch: async (url, options) => {
    const r = await f.send(url, options);
    if ((url.endsWith('/finish') && dropFinish) || (url.endsWith('/approve') && dropApprove)) {
      if (url.endsWith('/finish')) dropFinish = false; else dropApprove = false;
      await r.arrayBuffer(); throw Error('synthetic response lost AFTER server work');
    }
    return r;
  } }); await c.connect();
  const source = join(f.root, 'source'); await writeFile(source, 'one'); let lost;
  await assert.rejects(c.upload(source, { remotePath: '/tmp/one' }), error => { lost = error; return error.code === 'UPLOAD_RESULT_UNKNOWN' && /^[a-f0-9]{48}$/.test(error.transferId); });
  const same = await c.transfer(lost.transferId); assert.equal(same.job.state, 'pending'); assert.equal(f.app.queue.listAll().length, 1);
  assert.equal(f.calls.filter(x => x.path.endsWith('/finish')).length, 1); assert.equal(f.effects.length, 0);
  await assert.rejects(c.decide(same.job.id, 'approve', true), error => error.code === 'PORTAL_RESULT_UNKNOWN' && error.requestId === same.job.id);
  assert.equal((await c.status(same.job.id)).state, 'completed'); assert.equal((await c.decide(same.job.id, 'approve', true)).state, 'completed');
  assert.equal(f.calls.filter(x => x.path.endsWith('/approve')).length, 1); assert.equal(f.effects.length, 1);
});

test('redirects never carry owner credentials to a second listener; off-origin download URLs are refused', async t => {
  const f = await fixture(t); let leaked = 0;
  const sink = createServer((_req, res) => { leaked++; res.end('{}'); }); await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => sink.close(resolve)));
  const location = 'http://127.0.0.1:' + sink.address().port + '/leak';
  const redirector = createServer((_req, res) => { res.writeHead(302, { Location: location }); res.end(); }); await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => redirector.close(resolve)));
  const redirected = f.client({ fetch: (_url, options) => fetch('http://127.0.0.1:' + redirector.address().port, options) });
  const redirectResult = await redirected.connect().catch(error => error);
  assert.equal(leaked, 0, 'owner credential must never reach the redirect listener');
  assert.equal(redirectResult.code, 'PORTAL_READ_FAILED');
  const c = f.client({ fetch: async (url, options) => url.endsWith('/download') ? Response.json({ downloadUrl: location + '?ticket=synthetic' }) : f.send(url, options) }); await c.connect();
  f.remote.set('/tmp/known', Buffer.from('known')); const down = await c.requestDownload({ remotePath: '/tmp/known' }); await c.decide(down.id, 'approve', true);
  await assert.rejects(c.save(down.id, join(f.root, 'output')), { code: 'UNTRUSTED_DOWNLOAD_URL' }); assert.equal(leaked, 0); assert.equal(f.effects.length, 1);
});

test('truncated delivery never publishes; explicitly saving the same prepared artifact again does not rerun SSH', async t => {
  const f = await fixture(t); let truncate = true;
  const c = f.client({ fetch: async (url, options) => {
    const r = await f.send(url, options);
    if (url.includes('/downloads/') && truncate) { truncate = false; const bytes = await r.arrayBuffer(); return new Response(bytes.slice(0, 2), { headers: r.headers }); }
    return r;
  } }); await c.connect(); f.remote.set('/tmp/snapshot', Buffer.from('snapshot'));
  const down = await c.requestDownload({ remotePath: '/tmp/snapshot' }); await c.decide(down.id, 'approve', true);
  const dest = join(f.root, 'received'); await assert.rejects(c.save(down.id, dest), { code: 'DOWNLOAD_INTEGRITY_MISMATCH' });
  assert.equal((await readdir(f.root)).includes('received'), false); assert.equal(f.effects.length, 1);
  const saved = await c.save(down.id, dest); assert.equal(saved.state, 'saved'); assert.equal(saved.sha256, hash(Buffer.from('snapshot')));
  assert.equal(await readFile(dest, 'utf8'), 'snapshot'); assert.equal(f.effects.length, 1);
});

test('cancel after a known upload allocation stops before remote approval and never creates a replacement request', async t => {
  const f = await fixture(t), controller = new AbortController(), c = f.client({ signal: controller.signal }); await c.connect();
  const source = join(f.root, 'cancel'); await writeFile(source, 'cancelled'); let handle;
  await assert.rejects(c.upload(source, { remotePath: '/tmp/cancel' }, ({ transferId }) => { handle = transferId; controller.abort(); }), error => error.code === 'UPLOAD_RESULT_UNKNOWN' && error.transferId === handle);
  assert.equal(f.calls.filter(x => x.path === '/api/files/uploads').length, 1); assert.equal(f.calls.filter(x => x.path.endsWith('/chunks')).length, 0);
  assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.effects.length, 0);
});

test('CLI entry is inert on import and rejects invalid arguments before consuming private input', async () => {
  let consumed = false, stdout = '', stderr = '';
  async function* input() { consumed = true; yield 'SYNTHETIC_PRIVATE_CREDENTIAL'; }
  assert.equal(await main([], input(), { write: s => stdout += s }, { write: s => stderr += s }), 1);
  assert.equal(consumed, false); assert.equal(stdout, ''); assert.equal(stderr.includes('SYNTHETIC_PRIVATE'), false);
  stdout = ''; stderr = '';
  assert.equal(await main(['--help'], input(), { write: s => stdout += s }, { write: s => stderr += s }), 0);
  assert.equal(consumed, false); assert.match(stdout, /--access-token-stdin/); assert.equal(stderr, '');
});

test('Access client refuses other authentication modes and malformed session cookies without a fallback', async t => {
  const f = await fixture(t);
  for (const mode of ['oidc', 'token']) {
    const c = f.client({ fetch: async () => Response.json({ mode }) });
    await assert.rejects(c.connect(), { code: 'ACCESS_MODE_REQUIRED' });
  }
  assert.equal(f.calls.length, 0, 'an unsupported mode must not reach session/start');
  for (const cookie of ['__Host-ssh_admin_session=bad; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60',
    '__Host-ssh_admin_session=' + 'a'.repeat(64) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=60']) {
    const c = f.client({ fetch: async (url, options) => url.endsWith('/api/session/start') ? Response.json({ connected: true }, { headers: { 'Set-Cookie': cookie } }) : f.send(url, options) });
    await assert.rejects(c.connect(), { code: 'INVALID_OWNER_SESSION' }); assert.throws(() => c.targets(), { code: 'OWNER_SESSION_REQUIRED' });
  }
  assert.equal(f.app.queue.listAll().length, 0); assert.equal(f.effects.length, 0);
});

test('owner file admission rechecks the same session after a delayed body crosses logout or expiry', { timeout: 20000 }, async t => {
  const f = await fixture(t), meta = { remotePath: '/tmp/late', fileName: 'late', size: 1, sha256: hash(Buffer.from('x')) };
  for (const action of ['begin', 'chunk', 'finish', 'download', 'expiry']) {
    const expiresAt = Math.floor(Date.now() / 1000) + 5;
    const token = action === 'expiry' ? await f.jwt('alice', 'owner@example.test', expiresAt) : f.token;
    const proof = { 'cf-access-jwt-assertion': token };
    const login = await f.raw('/api/session/start', {}, proof); assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], headers = { ...proof, Cookie: cookie };
    let path = '/api/files/uploads', body = meta;
    if (['chunk', 'finish'].includes(action)) {
      const begin = await f.raw(path, meta, headers), id = (await begin.json()).transferId;
      path += '/' + id + (action === 'chunk' ? '/chunks' : '/finish');
      body = action === 'chunk' ? { sequence: 0, data: 'eA==' } : {};
      if (action === 'finish') assert.equal((await f.raw('/api/files/uploads/' + id + '/chunks', { sequence: 0, data: 'eA==' }, headers)).status, 200);
    } else if (action === 'download') { path = '/api/files/downloads'; body = { remotePath: '/tmp/late' }; }
    const before = f.app.store.list(), beforeJobs = f.app.queue.listAll().length, beforeEffects = f.effects.length;
    let bodyRead;
    const entered = new Promise(resolve => bodyRead = resolve);
    const observer = req => {
      if (req.headers['x-fixture-body-gate'] !== action) return;
      const original = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = () => {
        const iterator = original();
        return { [Symbol.asyncIterator]() { return this; }, async next(...args) { const result = await iterator.next(...args); if (!result.done) bodyRead(); return result; },
          return: (...args) => iterator.return(...args), throw: (...args) => iterator.throw(...args) };
      };
    };
    f.app.adminHttp.on('request', observer);
    const text = JSON.stringify(body); let request;
    const completed = new Promise((resolve, reject) => {
      request = httpRequest(f.loopback + path, { method: 'POST', headers: { ...headers, Origin: f.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'X-Fixture-Body-Gate': action } }, response => {
        const parts = []; response.on('data', part => parts.push(part)); response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts).toString('utf8') }));
      }); request.once('error', reject); request.write(text.slice(0, 1));
    });
    completed.catch(() => {}); t.after(() => request.destroy());
    await entered; f.app.adminHttp.off('request', observer);
    if (action === 'expiry') {
      // Actual signed token and app session expiry, without mocking the verifier/clock.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt * 1000 - Date.now() + 25)));
    } else {
      const logout = await f.raw('/api/session/logout', {}, headers); assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { connected: false });
    }
    request.end(text.slice(1));
    const result = await completed;
    assert.equal(result.status, 401, 'late ' + action + ' must be refused before a NEW file admission');
    assert.deepEqual(f.app.store.list(), before, 'no late allocation/append/finish after authority expired');
    assert.equal(f.app.queue.listAll().length, beforeJobs); assert.equal(f.effects.length, beforeEffects);
  }
});

const fileMutations = f => f.calls.filter(call => call.method === 'POST' && (call.path.startsWith('/api/files/') || call.path.endsWith('/approve'))).length;
async function interruptedUpload(t, { offset = 3, finish = false, tinyChunks = false } = {}) {
  const f = await fixture(t), bytes = Buffer.alloc(CHUNK_BYTES + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const source = join(f.root, 'original.bin'); await writeFile(source, bytes);
  let dropped = false, id;
  const c = f.client({ fetch: async (url, options) => {
    const path = new URL(url).pathname;
    if (!finish && !dropped && path.endsWith('/chunks')) {
      const body = JSON.parse(options.body); body.data = Buffer.from(body.data, 'base64').subarray(0, offset).toString('base64');
      if (tinyChunks) {
        const prefix = Buffer.from(body.data, 'base64');
        for (let i = 0; i < prefix.length; i++) {
          const accepted = await f.send(url, { ...options, body: JSON.stringify({ sequence: i, data: prefix.subarray(i, i + 1).toString('base64') }) });
          assert.equal(accepted.status, 200); await accepted.body.cancel();
        }
        dropped = true; throw Error('fixture reply lost after several accepted tiny chunks');
      }
      options = { ...options, body: JSON.stringify(body) };
    }
    const response = await f.send(url, options);
    if (!dropped && path.endsWith(finish ? '/finish' : '/chunks')) { dropped = true; await response.body.cancel(); throw Error('fixture reply lost after admission'); }
    return response;
  } });
  await c.connect();
  const error = await c.upload(source, { remotePath: '/tmp/resume.bin' }, record => { id = record.transferId; }).catch(error => error);
  assert.equal(error.code, 'UPLOAD_RESULT_UNKNOWN'); assert.equal(error.transferId, id);
  await c.close();
  return { ...f, bytes, source, id, intent: { remotePath: '/tmp/resume.bin' } };
}

test('resume sends only remaining bytes of the same transfer after lost chunk ACK, including an unaligned prefix', async t => {
  for (const [offset, tinyChunks] of [[3, false], [3, true], [CHUNK_BYTES, false]]) {
    const f = await interruptedUpload(t, { offset, tinyChunks }), writes = [], sequence = tinyChunks ? 3 : 1;
    assert.equal(f.app.store.get(f.id).received, offset); assert.equal(f.app.store.get(f.id).sequence, sequence);
    const c = f.client({ fetch: async (url, options) => {
      if (new URL(url).pathname.endsWith('/chunks')) { const body = JSON.parse(options.body); writes.push({ sequence: body.sequence, bytes: Buffer.from(body.data, 'base64').length }); }
      return f.send(url, options);
    } });
    await c.connect();
    const alias = join(f.root, 'same-bytes-renamed.bin'); await writeFile(alias, f.bytes);
    const job = await c.resumeUpload(f.id, alias, f.intent).catch(() => null);
    assert.ok(job?.state === 'pending', 'cursor resume must queue the exact remaining snapshot');
    assert.equal(job.operation.artifactId, f.id); assert.equal(job.operation.fileName, 'original.bin');
    assert.equal(writes[0].sequence, sequence); assert.equal(writes.reduce((sum, item) => sum + item.bytes, 0), f.bytes.length - offset);
    assert.equal(f.calls.filter(x => x.path === '/api/files/uploads' && x.method === 'POST').length, 1);
    assert.deepEqual(f.effects, []); await c.decide(job.id, 'approve', true);
    assert.deepEqual(f.remote.get('/tmp/resume.bin'), f.bytes); assert.equal(f.effects.length, 1);
  }
});

test('resume reconciles a lost finish ACK and observes every known job state without another mutation', async t => {
  const f = await interruptedUpload(t, { finish: true }), c = f.client(); await c.connect();
  const original = (await c.transfer(f.id)).job, before = fileMutations(f);
  const observed = await c.resumeUpload(f.id, f.source, f.intent).catch(() => null);
  assert.equal(fileMutations(f), before, 'existing upload job must not trigger any new mutation');
  assert.equal(observed?.id, original.id); assert.equal(observed.state, 'pending');
  await c.decide(original.id, 'approve', true); assert.equal(f.effects.length, 1);
  for (const state of ['pending', 'evaluating', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown']) {
    const observer = f.client({ fetch: async (url, options) => {
      const response = await f.send(url, options);
      if (options.method === 'GET' && new URL(url).pathname === '/api/files/uploads/' + f.id) {
        const value = await response.json(); return Response.json({ job: { ...value.job, state } });
      }
      return response;
    } });
    await observer.connect(); const count = fileMutations(f);
    const result = await observer.resumeUpload(f.id, f.source, f.intent).catch(() => null);
    assert.equal(fileMutations(f), count, 'existing upload job must not trigger any new mutation');
    assert.equal(result?.id, original.id); assert.equal(result.state, state); assert.equal(f.effects.length, 1);
  }
  const target = f.app.targets.select('default'); target.enabled = false;
  try {
    const count = fileMutations(f), historical = await c.resumeUpload(f.id, f.source, f.intent).catch(() => null);
    assert.equal(fileMutations(f), count, 'disabled target history must remain read-only');
    assert.equal(historical?.id, original.id, 'an existing job on a disabled target must remain observable');
    assert.equal(historical.state, 'completed'); assert.equal(f.effects.length, 1);
  } finally { target.enabled = true; }
});

test('resume rejects changed source bytes, size and original destination flags before any mutation', async t => {
  const f = await interruptedUpload(t), c = f.client(); await c.connect();
  const changed = Buffer.from(f.bytes); changed[5] ^= 1;
  const different = join(f.root, 'different.bin'), longer = join(f.root, 'longer.bin');
  await writeFile(different, changed); await writeFile(longer, Buffer.concat([f.bytes, Buffer.from('x')]));
  for (const [source, intent, code] of [[different, f.intent, 'RESUME_SOURCE_MISMATCH'], [longer, f.intent, 'RESUME_SOURCE_MISMATCH'],
    [f.source, { remotePath: '/tmp/elsewhere' }, 'RESUME_INTENT_MISMATCH'], [f.source, { ...f.intent, overwrite: true }, 'RESUME_INTENT_MISMATCH'],
    [f.source, { ...f.intent, elevate: true }, 'RESUME_INTENT_MISMATCH'], [f.source, { ...f.intent, target: 'other' }, 'INVALID_RESUME_INTENT'],
    [f.source, { ...f.intent, target: null }, 'INVALID_RESUME_INTENT'], [f.source, { ...f.intent, overwrite: 1 }, 'INVALID_RESUME_INTENT'],
    [f.source, { ...f.intent, extra: true }, 'INVALID_RESUME_INTENT']]) {
    const before = fileMutations(f), error = await c.resumeUpload(f.id, source, intent).catch(error => error);
    assert.equal(fileMutations(f), before, 'resume must reject mismatched source or intent before mutation');
    assert.equal(error.code, code); assert.equal(error.transferId, f.id);
  }
  assert.deepEqual(f.effects, []); assert.equal(f.app.queue.listAll().length, 0);
});

test('resume refuses malformed, ready, expired or missing staging without replacement work', async t => {
  const f = await interruptedUpload(t);
  for (const patch of [{ received: -1 }, { received: f.bytes.length + 1 }, { sequence: 0 }, { sequence: 4 }, { sequence: 1.5 },
    { expiresAt: 0 }, { state: 'ready' }, { id: 'f'.repeat(48) }, { targetId: null }]) {
    const c = f.client({ fetch: async (url, options) => {
      const response = await f.send(url, options);
      if (options.method === 'GET' && new URL(url).pathname === '/api/files/uploads/' + f.id) {
        const value = await response.json(); return Response.json({ transfer: { ...value.transfer, ...patch } });
      }
      return response;
    } });
    await c.connect(); const before = fileMutations(f), error = await c.resumeUpload(f.id, f.source, f.intent).catch(error => error);
    assert.equal(fileMutations(f), before); assert.ok(['UPLOAD_NOT_RESUMABLE', 'RESUME_INTENT_MISMATCH'].includes(error.code));
  }
  await f.app.store.remove(f.id); const c = f.client(); await c.connect(); const before = fileMutations(f);
  await assert.rejects(c.resumeUpload(f.id, f.source, f.intent), { code: 'PORTAL_REQUEST_REFUSED', transferId: f.id });
  assert.equal(fileMutations(f), before); assert.equal(f.app.queue.listAll().length, 0); assert.deepEqual(f.effects, []);
});

test('concurrent owner clients resuming one staging cursor produce at most one upload job', { timeout: 10_000 }, async t => {
  const f = await interruptedUpload(t, { offset: CHUNK_BYTES }); let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; }), timer = setTimeout(() => release(), 2000);
  const send = async (url, options) => {
    const response = await f.send(url, options);
    if (options.method === 'GET' && new URL(url).pathname === '/api/files/uploads/' + f.id) {
      const value = await response.json(); if (++reads === 2) release(); await gate; return Response.json(value);
    }
    return response;
  };
  const clients = [f.client({ fetch: send, timeoutMs: 5000 }), f.client({ fetch: send, timeoutMs: 5000 })];
  await Promise.all(clients.map(c => c.connect()));
  let outcomes; try { outcomes = await Promise.allSettled(clients.map(c => c.resumeUpload(f.id, f.source, f.intent))); } finally { clearTimeout(timer); release(); }
  assert.equal(reads, 2);
  const jobs = f.app.queue.listAll().filter(job => job.kind === 'upload' && job.operation.artifactId === f.id);
  assert.equal(jobs.length, 1); assert.ok(outcomes.some(x => x.status === 'fulfilled'));
  for (const outcome of outcomes.filter(x => x.status === 'fulfilled')) assert.equal(outcome.value.id, jobs[0].id);
  assert.equal(f.calls.filter(x => x.path === '/api/files/uploads' && x.method === 'POST').length, 1);
  assert.deepEqual(f.effects, []); await clients[0].decide(jobs[0].id, 'approve', true);
  assert.deepEqual(f.remote.get('/tmp/resume.bin'), f.bytes); assert.equal(f.effects.length, 1);
});

test('resume handles an allocated empty file without chunks or a replacement allocation', async t => {
  const f = await fixture(t), source = join(f.root, 'empty.bin'); await writeFile(source, Buffer.alloc(0));
  const first = f.client(); await first.connect(); let id;
  await assert.rejects(first.upload(source, { remotePath: '/tmp/empty-resume' }, record => { id = record.transferId; throw Error('fixture interrupt after allocation'); }), { code: 'UPLOAD_RESULT_UNKNOWN' });
  await first.close(); const c = f.client(); await c.connect();
  const before = f.calls.filter(x => x.path.endsWith('/chunks')).length;
  const job = await c.resumeUpload(id, source, { remotePath: '/tmp/empty-resume' });
  assert.equal(job.operation.artifactId, id); assert.equal(job.operation.size, 0); assert.equal(job.operation.sha256, hash(Buffer.alloc(0)));
  assert.equal(f.calls.filter(x => x.path.endsWith('/chunks')).length, before);
  assert.equal(f.calls.filter(x => x.method === 'POST' && x.path === '/api/files/uploads').length, 1);
  assert.deepEqual(f.effects, []); await c.decide(job.id, 'approve', true);
  assert.equal(f.remote.get('/tmp/empty-resume').length, 0); assert.equal(f.effects.length, 1);
});

test('revoking the same resume session after cursor read prevents any new chunk admission', async t => {
  const f = await interruptedUpload(t); let revoked = false;
  const c = f.client({ fetch: async (url, options) => {
    const response = await f.send(url, options);
    if (!revoked && options.method === 'GET' && new URL(url).pathname === '/api/files/uploads/' + f.id) {
      revoked = true; const logout = await f.raw('/api/session/logout', {}, { Cookie: options.headers.Cookie });
      assert.equal(logout.status, 200); await logout.body.cancel();
    }
    return response;
  } });
  await c.connect(); const before = f.app.store.get(f.id);
  await assert.rejects(c.resumeUpload(f.id, f.source, f.intent), { code: 'OWNER_REAUTH_REQUIRED', transferId: f.id });
  assert.equal(revoked, true); assert.deepEqual(f.app.store.get(f.id), before);
  assert.equal(f.app.queue.listAll().length, 0); assert.deepEqual(f.effects, []);
});
