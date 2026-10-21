import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';
import { executePythonSource } from '../src/adapters/ssh/vendor.mjs';
import { preparePythonSource, PYTHON_SOURCE_ENVIRONMENT_REVISION } from '../src/adapters/ssh/python-source.mjs';

const binding = { targetId: 'fixture', targetRevision: 'a'.repeat(64), profile: 'fixture-write' };
const prepare = (source = 'pass\n', rest = {}) => preparePythonSource({ ...binding, cwd: '/', source, ...rest });
const verify = () => ({ ...binding });
function fake(profileChanges = {}, acquire = () => {}) {
  const calls = [], profile = { name: binding.profile, tty: false, readOnly: false, ...profileChanges };
  const connection = { profile, async exec(...args) { calls.push(args); return { stdout: 'ok', stderr: '', exitCode: 0 }; } };
  let acquisitions = 0;
  return { calls, connection, get acquisitions() { return acquisitions; }, registry: {
    getProfile: () => profile,
    async getOrCreate() { acquisitions++; await acquire(); return connection; },
  } };
}

test('SOURCE-SSH-01 malformed plan and writable/nonTTY/explicit-cwd guards refuse before SSH exec', async () => {
  const p = prepare();
  for (const change of [{ tty: true }, { readOnly: true }, { workdir: '/tmp' }]) {
    const f = fake(change);
    await assert.rejects(executePythonSource(f.registry, p, verify), /requires/);
    assert.equal(f.calls.length, 0, 'SOURCE-SSH-01: profile refusal must not dispatch');
  }
  for (const changed of [{ ...p, stdin: 'print(1)\n' }, { ...p, command: 'id' }, { ...p, planDigest: 'c'.repeat(64) },
    { ...p, manifest: { ...p.manifest, sourceBytes: 1 } }, { ...p, args: ['-c', 'pass'] }]) {
    const f = fake(); await assert.rejects(executePythonSource(f.registry, changed, verify)); assert.equal(f.acquisitions, 0);
  }
  const f = fake(); await assert.rejects(executePythonSource(f.registry, p, () => ({ ...binding, targetRevision: 'b'.repeat(64) })), /binding changed/);
  assert.equal(f.acquisitions, 0);
});

test('SOURCE-SSH-02 async target/profile changes are checked after acquiring the connection', async () => {
  let revision = binding.targetRevision;
  const f = fake({}, () => { revision = 'b'.repeat(64); });
  await assert.rejects(executePythonSource(f.registry, prepare(), () => ({ ...binding, targetRevision: revision })), /binding changed/);
  assert.equal(f.calls.length, 0);
  const other = fake(); other.registry.getProfile = () => ({ ...other.connection.profile, host: 'other' });
  await assert.rejects(executePythonSource(other.registry, prepare(), verify), /profile changed/); assert.equal(other.calls.length, 0);
});

test('SOURCE-SSH-03 admitted plan is an immutable snapshot and dispatch exceptions never replay or expose source', async () => {
  const original = prepare("print('private-body-marker')\n");
  const submitted = { ...original, manifest: { ...original.manifest } };
  const f = fake({}, () => { submitted.manifest.targetId = 'changed'; submitted.stdin = 'different'; });
  assert.equal((await executePythonSource(f.registry, submitted, verify)).failed, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], original.command); assert.equal(f.calls[0][1].stdin, original.stdin);
  const failing = fake(); let calls = 0;
  failing.connection.exec = async () => { calls++; throw Error('private-body-marker'); };
  await assert.rejects(executePythonSource(failing.registry, original, verify), error => /unknown; do not retry/.test(error.message) && !error.message.includes('private-body-marker'));
  assert.equal(calls, 1);
});

const python = process.env.SOLID_PYTHON ?? (process.platform === 'win32'
  ? 'C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' : 'python3');
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('SOURCE-SSH-04 pinned real loopback SSH preserves UTF8 bytes, clean env and blocks short/wrong delivery effects', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-source-ssh-'));
  const hostKey = key(), clients = new Set(), children = new Set(), received = [];
  let current, fault = 'none', fixtureError;
  // This is a real SSH transport fixture. It validates the exact command string
  // then launches the same receiver argv with shell:false; it is not POSIX shell
  // parsing, OpenSSH on Linux, or a production-server attestation.
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', request => request.accept());
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (_accept, reject) => reject());
      session.on('env', accept => accept?.());
      session.on('exec', (accept, reject, info) => {
        const p = current;
        if (info.command !== p.command) { fixtureError = 'Source command differs from the planned receiver'; reject(); return; }
        const stream = accept(), chunks = []; stream.on('error', () => {});
        stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream.once('end', () => {
          const bytes = Buffer.concat(chunks); received.push({ command: info.command, bytes: bytes.length, digest: sha(bytes) });
          let delivered = bytes;
          if (fault === 'short') delivered = bytes.subarray(0, bytes.indexOf(Buffer.from('print(')));
          if (fault === 'wrong') { delivered = Buffer.from(bytes); delivered[0] ^= 1; }
          const child = spawn(python, p.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            env: { ...process.env, JEV_SYNTHETIC_ENV_MARKER: 'must-not-reach-source' } });
          children.add(child); child.stdin.on('error', () => {});
          child.stdout.on('data', chunk => stream.write(chunk)); child.stderr.on('data', chunk => stream.stderr.write(chunk));
          child.once('error', () => { fixtureError = 'Python fixture spawn failed'; stream.exit(1); stream.end(); });
          child.once('close', (code, signal) => { children.delete(child); stream.exit(Number.isInteger(code) ? code : 1); stream.end(); });
          stream.once('close', () => { if (child.exitCode === null) child.kill(); });
          child.stdin.end(delivered);
        });
      });
    }));
  });
  let connection;
  t.after(async () => {
    await connection?.close(); for (const child of children) child.kill(); for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    assert.ok(directory.startsWith(join(tmpdir(), 'jev-source-ssh-')));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const trustedHostKey = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const profile = { name: binding.profile, host: '127.0.0.1', port: server.address().port, user: 'synthetic', auth: 'key',
    trustedHostKey, readOnly: false, tty: false, announceAgent: false, timeout: 8000, maxOutputBytes: 65536 };
  connection = new SSHConnection(profile, { privateKey: key() }, new Map(), 'strict');
  const registry = { getProfile: () => profile, async getOrCreate() { await connection.ensureConnected(); return connection; } };
  current = prepare("import os,json,sys\nassert sys.flags.utf8_mode==1\nprint(json.dumps(dict(os.environ),sort_keys=True))\n# 한글 exact UTF-8\n");
  const result = await executePythonSource(registry, current, verify);
  assert.equal(result.failed, false, result.texts.join('\n'));
  assert.deepEqual(JSON.parse(result.texts[0]), { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin' });
  assert.equal(received[0].bytes, current.manifest.sourceBytes); assert.equal(received[0].digest, current.manifest.sourceSha256);
  assert.equal(current.manifest.environmentRevision, PYTHON_SOURCE_ENVIRONMENT_REVISION);
  for (const mode of ['short', 'wrong']) {
    fault = mode; const marker = join(directory, mode + '.txt');
    current = prepare("import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('marker',encoding='utf-8')\nprint('한글')\n", { argv: [marker] });
    const outcome = await executePythonSource(registry, current, verify);
    assert.equal(outcome.failed, true); assert.match(outcome.texts[0], /exit 125/);
    assert.equal(await access(marker).then(() => true, () => false), false, 'Corrupted SSH delivery must not execute the valid marker prefix');
    assert.equal(received.at(-1).bytes, current.manifest.sourceBytes); assert.equal(received.at(-1).digest, current.manifest.sourceSha256);
  }
  assert.equal(received.length, 3, 'No source dispatch may be replayed'); assert.equal(fixtureError, undefined);
});
