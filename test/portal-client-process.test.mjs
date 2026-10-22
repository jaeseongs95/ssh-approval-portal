import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApplication } from '../app.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';

const runFile = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  let openssl = process.env.OWNER_CLI_TEST_OPENSSL;
  if (!openssl) {
    const gitOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
    openssl = process.platform === 'win32' && await access(gitOpenSSL).then(() => true, () => false) ? gitOpenSSL : 'openssl';
  }
  try { await runFile(openssl, ['version'], { timeout: 10_000, windowsHide: true }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('OpenSSL fixture prerequisite unavailable; no installation attempted'); return; } throw error; }
  const root = await mkdtemp(join(tmpdir(), 'owner-cli-native-'));
  let app, edge, loseChunkReply = false;
  const children = new Set(), calls = [], effects = [], remote = new Map(), staged = new Map(), invocations = [];
  t.after(async () => {
    for (const child of children) child.kill();
    if (edge) { edge.closeAllConnections(); await new Promise(resolve => edge.close(resolve)); }
    await app?.close();
    assert.ok(root.startsWith(join(tmpdir(), 'owner-cli-native-')));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    assert.equal(children.size, 0, 'all owned CLI processes must be terminal');
  });
  const cert = join(root, 'fixture-cert.pem'), key = join(root, 'fixture-key.pem');
  await runFile(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=owner-cli-native',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { timeout: 15_000, windowsHide: true });
  // This loopback TLS peer models only Cloudflare header forwarding. The CLI's
  // fetch/TLS, signed owner verification, app sessions, queue and files are real.
  edge = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const headers = { ...req.headers, 'cf-access-jwt-assertion': req.headers['cf-access-token'] ?? '' };
    delete headers['cf-access-token'];
    calls.push({ method: req.method, path: new URL(req.url, 'https://fixture.test').pathname });
    const upstream = request({ host: '127.0.0.1', port: app.adminHttp.address().port, path: req.url, method: req.method, headers }, reply => {
      if (loseChunkReply && req.method === 'POST' && req.url.endsWith('/chunks') && reply.statusCode === 200) {
        loseChunkReply = false; reply.resume(); reply.once('end', () => res.destroy()); return;
      }
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  edge.on('tlsClientError', () => {});
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
  const origin = 'https://127.0.0.1:' + edge.address().port;
  const issuer = 'https://fixture.cloudflareaccess.com', aud = 'a'.repeat(64);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand: async () => assert.fail('No command execution'),
    audit: () => {}, transferRoot: join(root, 'store'), uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-maintenance', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64),
      BRIDGE_ADMIN_ORIGIN: origin, BRIDGE_ADMIN_AUTH_MODE: 'access', BRIDGE_ACCESS_TEAM_DOMAIN: issuer,
      BRIDGE_ACCESS_AUD: aud, BRIDGE_ACCESS_OWNER_EMAILS: 'owner@example.test' },
    accessKeySet: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'fixture' }] }) });
  // Only the remote SSH/helper endpoint is synthetic; approval and file services
  // remain unchanged. Count actual publications/snapshots independently.
  app.transfers.transport = { connect: async () => ({
    upload: async (source, path) => { const parts = []; for await (const bytes of source) parts.push(Buffer.from(bytes)); staged.set(path.split('/').at(-1).slice(0, -5), Buffer.concat(parts)); },
    download: async (path, destination) => destination.end(staged.get(path.split('/').at(-1).slice(0, -5))),
    call: async (_command, op) => {
      if (op.action === 'publish') {
        assert.equal(remote.has(op.remotePath) && !op.overwrite, false);
        const bytes = staged.get(op.id); assert.equal(bytes.length, op.size); assert.equal(hash(bytes), op.sha256);
        remote.set(op.remotePath, bytes); effects.push('upload');
        return { exitCode: 0, stdout: JSON.stringify({ size: bytes.length, sha256: hash(bytes) }) };
      }
      if (op.action === 'snapshot') {
        const bytes = remote.get(op.remotePath); assert.ok(bytes); staged.set(op.id, Buffer.from(bytes)); effects.push('download');
        return { exitCode: 0, stdout: JSON.stringify({ size: bytes.length, sha256: hash(bytes) }) };
      }
      assert.equal(op.action, 'cleanup'); staged.delete(op.id); return { exitCode: 0, stdout: '{}' };
    },
  }) };
  await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
  const jwt = email => new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer(issuer).setAudience(aud).setSubject(email).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const token = await jwt('owner@example.test');
  const raw = (path, body, extra = {}) => fetch('http://127.0.0.1:' + app.adminHttp.address().port + path,
    { method: body === undefined ? 'GET' : 'POST', headers: { 'cf-access-jwt-assertion': token, Origin: origin, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function cli(args, { credential = token, trust = true } = {}) {
    const argv = [join(repository, 'scripts/portal-client.mjs'), '--origin', origin, '--access-token-stdin', ...args];
    assert.equal(argv.includes(credential), false);
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    if (trust) env.NODE_EXTRA_CA_CERTS = cert; // Child-local CA; no global trust or TLS bypass.
    const child = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: AbortSignal.timeout(15_000) });
    children.add(child);
    let stdout = '', stderr = '';
    for (const [stream, append] of [[child.stdout, bytes => { stdout += bytes; }], [child.stderr, bytes => { stderr += bytes; }]]) stream.on('data', bytes => { append(bytes); if (stdout.length + stderr.length > 1024 * 1024) child.kill(); });
    child.stdin.on('error', () => {});
    const terminal = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); }); });
    child.stdin.end(credential + '\n');
    const result = await terminal;
    assert.equal((stdout + stderr).includes(credential), false, 'native process must keep credential private');
    for (const secret of ['__Host-ssh_admin_session=', 'ticket=']) assert.equal((stdout + stderr).includes(secret), false);
    invocations.push({ command: args[0], code: result.code, signal: result.signal });
    return { ...result, stdout, stderr, value: stdout ? JSON.parse(stdout) : null };
  }
  return { root, app, token, jwt, raw, cli, calls, effects, remote, invocations, loseNextChunkReply: () => { loseChunkReply = true; } };
}

test('native CLI process uses verified TLS and private stdin through approval and exact local file roundtrip', { timeout: 60_000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const session = await f.raw('/api/session/start', {}), cookie = session.headers.get('set-cookie').split(';')[0]; await session.body.cancel();
  const ok = async args => { const r = await f.cli(args); assert.equal(r.code, 0, r.stderr); return r.value; };
  assert.equal((await ok(['targets'])).defaultTarget, 'default');
  const bytes = Buffer.alloc(CHUNK_BYTES + 9); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const source = join(f.root, '원본 파일.bin'); await writeFile(source, bytes);
  const upload = await ok(['upload', source, '/tmp/native.bin']);
  assert.equal(upload.state, 'pending'); assert.equal(upload.operation.sha256, hash(bytes)); assert.deepEqual(f.effects, []);
  assert.equal((await ok(['transfer', upload.operation.artifactId])).job.id, upload.id);
  const pending = await ok(['pending']); assert.ok(JSON.stringify(pending).includes(upload.id));
  const refused = await f.cli(['approve', upload.id]);
  assert.equal(refused.code, 1, 'native approval must require explicit confirmation'); assert.ok(refused.stderr.includes('EXPLICIT_OWNER_DECISION_REQUIRED')); assert.deepEqual(f.effects, []);
  assert.equal((await ok(['approve', upload.id, '--confirm'])).state, 'completed');
  assert.deepEqual(f.remote.get('/tmp/native.bin'), bytes); assert.deepEqual(f.effects, ['upload']);
  const approvals = f.calls.filter(x => x.path.endsWith('/approve')).length;
  assert.equal((await ok(['approve', upload.id, '--confirm'])).state, 'completed');
  assert.equal(f.calls.filter(x => x.path.endsWith('/approve')).length, approvals);
  const download = await ok(['request-download', '/tmp/native.bin']); assert.equal(download.state, 'pending');
  const destination = join(f.root, '저장 파일.bin');
  assert.equal((await f.cli(['save', download.id, destination])).code, 1); assert.deepEqual(f.effects, ['upload']);
  await ok(['approve', download.id, '--confirm']); assert.deepEqual(f.effects, ['upload', 'download']);
  assert.equal((await ok(['status', download.id])).state, 'completed');
  const saved = await ok(['save', download.id, destination]); assert.equal(saved.state, 'saved'); assert.equal(saved.sha256, hash(bytes)); assert.deepEqual(await readFile(destination), bytes);
  const conflict = await f.cli(['save', download.id, destination]); assert.equal(conflict.code, 1); assert.ok(conflict.stderr.includes('EEXIST')); assert.deepEqual(await readFile(destination), bytes); assert.deepEqual(f.effects, ['upload', 'download']);
  await writeFile(source, Buffer.alloc(0));
  const empty = await ok(['upload', source, '/tmp/empty']); await ok(['approve', empty.id, '--confirm']); assert.equal(f.remote.get('/tmp/empty').length, 0);
  const emptyDownload = await ok(['request-download', '/tmp/empty']); await ok(['approve', emptyDownload.id, '--confirm']);
  const emptyDestination = join(f.root, '빈 파일.bin'); const emptySaved = await ok(['save', emptyDownload.id, emptyDestination]);
  assert.equal(emptySaved.state, 'saved'); assert.equal(emptySaved.sha256, hash(Buffer.alloc(0))); assert.equal((await readFile(emptyDestination)).length, 0);
  const denied = await ok(['request-download', '/tmp/native.bin']); assert.equal((await ok(['deny', denied.id, '--confirm'])).state, 'denied'); assert.deepEqual(f.effects, ['upload', 'download', 'upload', 'download']);
  const otherSession = await f.raw('/api/pending', undefined, { Cookie: cookie }); assert.equal(otherSession.status, 200); await otherSession.body.cancel();
  t.diagnostic(JSON.stringify({ nativeChildInvocations: f.invocations.length, multiChunkBytes: bytes.length, emptyUploadBytes: 0, remoteEffects: f.effects.length, otherSessionPreserved: true, credentialsPrivate: true }));
});

test('native CLI process refuses untrusted TLS and non-owner identity without new file jobs or effects', { timeout: 30_000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const count = f.app.queue.listAll().length, before = f.calls.length;
  const tls = await f.cli(['targets'], { trust: false }); assert.equal(tls.code, 1); assert.equal(tls.stdout, ''); assert.ok(tls.stderr.includes('PORTAL_READ_FAILED')); assert.equal(f.calls.length, before);
  const owner = await f.cli(['request-download', '/tmp/native.bin'], { credential: await f.jwt('other@example.test') });
  assert.equal(owner.code, 1); assert.equal(owner.stdout, ''); assert.ok(owner.stderr.includes('OWNER_REAUTH_REQUIRED'));
  assert.equal(f.app.queue.listAll().length, count); assert.deepEqual(f.effects, []);
  t.diagnostic(JSON.stringify({ nativeChildInvocations: f.invocations.length, untrustedTlsRefused: true, nonOwnerRefused: true, fileJobsCreated: 0, remoteEffects: 0 }));
});

test('a fresh native CLI process explicitly resumes the same transfer after an accepted chunk reply is lost', { timeout: 30_000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const bytes = Buffer.alloc(CHUNK_BYTES + 7); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const source = join(f.root, 'resume.bin'); await writeFile(source, bytes); f.loseNextChunkReply();
  const lost = await f.cli(['upload', source, '/tmp/resumed.bin']); assert.equal(lost.code, 1); assert.equal(lost.stdout, '');
  const records = lost.stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const id = records.at(-1).transferId; assert.match(id, /^[a-f0-9]{48}$/); assert.equal(f.app.store.get(id).received, CHUNK_BYTES);
  const beginCount = f.calls.filter(x => x.method === 'POST' && x.path === '/api/files/uploads').length;
  const resumed = await f.cli(['resume-upload', id, source, '/tmp/resumed.bin']); assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.value.state, 'pending'); assert.equal(resumed.value.operation.artifactId, id);
  assert.equal(f.calls.filter(x => x.method === 'POST' && x.path === '/api/files/uploads').length, beginCount); assert.deepEqual(f.effects, []);
  const approved = await f.cli(['approve', resumed.value.id, '--confirm']); assert.equal(approved.code, 0); assert.deepEqual(f.remote.get('/tmp/resumed.bin'), bytes); assert.deepEqual(f.effects, ['upload']);
  const before = f.calls.filter(x => x.method === 'POST' && x.path.startsWith('/api/files/')).length;
  const observed = await f.cli(['resume-upload', id, source, '/tmp/resumed.bin']); assert.equal(observed.code, 0); assert.equal(observed.value.id, resumed.value.id); assert.equal(observed.value.state, 'completed');
  assert.equal(f.calls.filter(x => x.method === 'POST' && x.path.startsWith('/api/files/')).length, before); assert.deepEqual(f.effects, ['upload']);
  t.diagnostic(JSON.stringify({ nativeChildInvocations: f.invocations.length, transferIdRetained: true, beginRequests: beginCount, remoteEffects: 1, completedResumeMutations: 0 }));
});
