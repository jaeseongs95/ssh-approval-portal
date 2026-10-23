import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { main } from '../scripts/portal-client.mjs';

const origin = 'https://portal.example.test';
const credential = 'synthetic.header.signature';
const helper = process.execPath; // Absolute executable; the credential boundary is injected below.
const jobId = 'a'.repeat(48), transferId = 'd'.repeat(48);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (value, headers = {}) => Response.json(value, { headers });

function portal(t, extra = () => undefined) {
  const oldFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
    assert.equal(options.headers['cf-access-token'], credential);
    if (path === '/api/session') return json({ mode: 'access' });
    if (path === '/api/session/start') return json({ connected: true }, { 'Set-Cookie': '__Host-ssh_admin_session=' + 'f'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60' });
    if (path === '/api/session/logout') return json({ connected: false });
    if (path === '/api/targets') return json({ defaultTarget: 'default', targets: [{ id: 'default', enabled: true }] });
    const response = await extra(path, options, requests.at(-1).body);
    assert.ok(response, 'unexpected portal request: ' + path);
    return response;
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  return requests;
}

async function invoke(args, { token = credential, failure, input = [], mode = ['--cloudflared', helper] } = {}) {
  let stdout = '', stderr = ''; const executions = [];
  const execute = (file, argv, options) => {
    executions.push({ file, argv, options });
    if (failure) throw failure;
    return token;
  };
  const code = await main(['--origin', origin, ...mode, ...args], Readable.from(input),
    { write: text => { stdout += text; } }, { write: text => { stderr += text; } }, execute);
  return { code, stdout, stderr, executions };
}

async function localFile(t) {
  const prefix = join(tmpdir(), 'portal-cloudflared-');
  const root = await mkdtemp(prefix);
  t.after(async () => { assert.ok(root.startsWith(prefix)); await rm(root, { recursive: true, force: true }); });
  const source = join(root, '공개 원본.bin'), bytes = Buffer.from([0, 1, 2, 127, 128, 255, 10]);
  await writeFile(source, bytes, { flag: 'wx' });
  return { root, source, bytes };
}

test('stdin credential mode remains available without invoking cloudflared', async t => {
  const requests = portal(t);
  const r = await invoke(['targets'], { mode: ['--access-token-stdin'], input: [credential + '\n'] });
  assert.equal(r.code, 0); assert.equal(r.executions.length, 0);
  assert.equal(JSON.parse(r.stdout).defaultTarget, 'default');
  assert.equal(requests.filter(x => x.path === '/api/targets').length, 1);
  assert.equal((r.stdout + r.stderr).includes(credential), false);
});

test('cached helper mode connects privately once with a finite execution budget', async t => {
  portal(t);
  const r = await invoke(['targets']);
  assert.equal(r.code, 0, 'cached helper mode must connect');
  assert.equal(r.executions.length, 1);
  const e = r.executions[0];
  assert.equal(e.file, helper); assert.deepEqual(e.argv, ['access', 'token', '--app=' + origin]);
  assert.equal(e.options.timeout, 30_000); assert.equal(e.options.maxBuffer, 16386);
  assert.equal(e.options.killSignal, 'SIGKILL'); assert.equal(e.options.windowsHide, true);
  assert.deepEqual(e.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.notEqual(e.options.shell, true); assert.equal(e.options.env, undefined);
  assert.equal(JSON.stringify(e).includes(credential), false);
  assert.equal((r.stdout + r.stderr).includes(credential), false);
});

test('invalid mode, origin, helper path and flags refuse before credential or portal access', async t => {
  const requests = portal(t);
  const invalid = [
    { mode: [] }, { mode: ['--cloudflared', helper, '--access-token-stdin'] },
    { mode: ['--cloudflared', 'relative-helper'] },
    { mode: ['--cloudflared', helper, '--origin', 'http://portal.example.test'] },
    { mode: ['--cloudflared', helper], args: ['targets', '--confirm'] },
    { args: ['status', 'bad-id'] },
    { args: ['transfer', 'a'.repeat(47)] },
    { args: ['approve', jobId] },
    { args: ['deny', jobId] },
    { args: ['upload', 'relative.bin', '/home/fixture/new.bin'] },
    { args: ['save', jobId, 'relative.bin'] },
    { args: ['resume-upload', transferId, 'relative.bin', '/home/fixture/new.bin'] },
    { args: ['request-download', '/home/../bad.bin'] },
    { args: ['request-download', '/home/fixture/new.bin', '--target', 'bad!'] },
    { args: ['upload', join(tmpdir(), 'unused-fixture.bin') + '\0', '/home/fixture/new.bin'] },
    ...(process.platform === 'win32' ? [{ mode: ['--cloudflared', 'C:\\tools\\con.exe'] }, { args: ['save', jobId, 'C:\\work\\file.bin:stream'] }] : []),
  ];
  for (const fixture of invalid) {
    const r = await invoke(fixture.args ?? ['targets'], fixture);
    assert.equal(r.code, 1); assert.equal(r.executions.length, 0, 'invalid input must refuse before helper'); assert.equal(r.stdout, '');
  }
  assert.equal(requests.length, 0);
});

test('helper failures suppress raw stdout stderr and never retry or reach the portal', async t => {
  const requests = portal(t);
  for (const code of ['ETIMEDOUT', 'ENOENT', 'ENOBUFS']) {
    const failure = Object.assign(new Error('vendor message ' + credential), { code, stdout: credential, stderr: credential });
    const r = await invoke(['targets'], { failure });
    assert.equal(r.code, 1);
    assert.deepEqual(JSON.parse(r.stderr), { error: 'ACCESS_CREDENTIAL_UNAVAILABLE' }, 'helper failure must remain public and stop');
    assert.equal(r.executions.length, 1); assert.equal(r.stdout, '');
    assert.equal(r.stderr.includes(credential), false);
  }
  assert.equal(requests.length, 0);
});

test('empty malformed and oversized cached credentials refuse before portal access', async t => {
  const requests = portal(t);
  for (const token of ['', 'not-a-jwt', credential + '\n' + credential, 'a'.repeat(16385) + '.b.c']) {
    const r = await invoke(['targets'], { token });
    assert.equal(r.code, 1); assert.equal(r.executions.length, 1);
    assert.equal(r.stdout, ''); assert.equal(requests.length, 0);
    assert.deepEqual(JSON.parse(r.stderr), { error: 'INVALID_ACCESS_CREDENTIAL' });
  }
});

test('pending command status stays pending without an approval mutation', async t => {
  const requests = portal(t, path => path === '/api/' + jobId ? json({ id: jobId, state: 'pending' }) : undefined);
  const r = await invoke(['status', jobId]);
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).state, 'pending');
  assert.equal(requests.filter(x => /\/(approve|deny)$/.test(x.path)).length, 0);
});

test('lost upload response retains the same transfer ID without begin or chunk replay', async t => {
  const fixture = await localFile(t);
  const requests = portal(t, path => {
    if (path === '/api/files/uploads') return json({ transferId });
    if (path === '/api/files/uploads/' + transferId + '/chunks') throw Error('private transport message ' + credential);
  });
  const r = await invoke(['upload', fixture.source, '/home/fixture/new.bin']);
  assert.equal(r.code, 1); assert.equal(r.executions.length, 1);
  assert.deepEqual(JSON.parse(r.stderr.trim().split('\n').at(-1)), { error: 'UPLOAD_RESULT_UNKNOWN', transferId });
  assert.equal(requests.filter(x => x.path === '/api/files/uploads').length, 1);
  assert.equal(requests.filter(x => x.path.endsWith('/chunks')).length, 1);
  assert.equal(requests.some(x => x.path.endsWith('/finish')), false);
  assert.equal((r.stdout + r.stderr).includes(credential), false);
});

test('cached authentication preserves upload bytes and a pending upload ACK', async t => {
  const fixture = await localFile(t), digest = hash(fixture.bytes);
  const requests = portal(t, (path, _options, body) => {
    if (path === '/api/files/uploads') { assert.equal(body.sha256, digest); return json({ transferId }); }
    if (path.endsWith('/chunks')) { assert.deepEqual(Buffer.from(body.data, 'base64'), fixture.bytes); return json({ sequence: 1, received: fixture.bytes.length }); }
    if (path.endsWith('/finish')) return json({ id: jobId, kind: 'upload', state: 'pending', operation: { artifactId: transferId, size: fixture.bytes.length, sha256: digest } });
  });
  const r = await invoke(['upload', fixture.source, '/home/fixture/new.bin']);
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).state, 'pending');
  assert.equal(requests.filter(x => x.path.endsWith('/finish')).length, 1);
  assert.equal(requests.some(x => x.path.endsWith('/approve')), false);
});

test('cached authentication reports saved only after exclusive local byte and hash verification', async t => {
  const fixture = await localFile(t), destination = join(fixture.root, '저장 결과.bin');
  const metadata = { artifactId: transferId, size: fixture.bytes.length, sha256: hash(fixture.bytes) };
  portal(t, path => {
    if (path === '/api/' + jobId) return json({ id: jobId, kind: 'download', state: 'completed', result: { structuredContent: metadata } });
    if (path === '/api/' + jobId + '/download') return json({ downloadUrl: origin + '/downloads/' + transferId + '/' + 'b'.repeat(32) + '?ticket=synthetic' });
    if (path.startsWith('/downloads/')) return new Response(fixture.bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(fixture.bytes.length) } });
  });
  const r = await invoke(['save', jobId, destination]);
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).state, 'saved');
  assert.deepEqual(await readFile(destination), fixture.bytes);
  assert.equal(JSON.parse(r.stdout).sha256, metadata.sha256);
  assert.equal(r.executions.length, 1); assert.equal((r.stdout + r.stderr).includes(credential), false);
});
