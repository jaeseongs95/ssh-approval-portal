import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { resolveCloudflared, cachedAccessToken } from '../src/adapters/cli/cloudflared.mjs';
import { diagnoseClient } from '../src/adapters/cli/doctor.mjs';
import { main } from '../scripts/portal-client.mjs';

// engineering-test-plan: node:test, component boundaries plus CLI/fetch integration.
// Discovery: explicit > configured environment > bounded absolute PATH; filesystem
// fixtures provide the oracle independently of the resolver. Credentials: one
// injected process invocation, stable failure codes, no private output. Doctor:
// ready/blocked stages and exact allowed client/HTTP calls prove no SSH/file or
// approval submission. Excludes real login, SSH, uploads and model behavior.
// engineering-test-proof/result: NOT_RUN by author; run only in the authorized
// test server/Actions environment (package Node 24.2 <= version < 25).

const origin = 'https://portal.example.test';
const credential = 'SYNTHETIC_PRIVATE.header.signature';
const executable = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const errorWithCode = code => Object.assign(new Error('PRIVATE_HELPER_DIAGNOSTIC'), {
  code, stdout: credential, stderr: 'PRIVATE_HELPER_DIAGNOSTIC ' + credential,
});
const codeIs = code => error => {
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE|PRIVATE_HELPER_DIAGNOSTIC/);
  assert.equal(error.stdout, undefined);
  assert.equal(error.stderr, undefined);
  return true;
};

async function fixture(t) {
  const prefix = join(tmpdir(), 'portal-discovery-');
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  async function helper(directory, name = executable, mode = 0o700) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    // Synthetic executable metadata only. Tests never execute this file.
    await writeFile(path, 'synthetic helper fixture', { flag: 'wx', mode });
    if (process.platform !== 'win32') await chmod(path, mode);
    return path;
  }
  return { root, helper };
}

function noSideEffects(result) {
  assert.equal(result.remoteOperationSubmitted, false);
  assert.equal(result.automaticLogin, false);
  assert.equal(result.automaticInstall, false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|PRIVATE_HELPER_DIAGNOSTIC|__Host-ssh_admin_session=/);
}

function injectedClient({ connectFailure, targetsFailure, targets = [{ id: 'default', enabled: true }] } = {}) {
  const calls = [];
  const openClient = options => {
    calls.push('open');
    assert.equal(options.origin, origin);
    assert.equal(options.accessToken, credential);
    assert.equal(options.timeoutMs, 30000);
    return {
      async connect() { calls.push('connect'); if (connectFailure) throw connectFailure; },
      async targets() { calls.push('targets'); if (targetsFailure) throw targetsFailure; return { targets }; },
      async close() { calls.push('close'); },
    };
  };
  return { calls, openClient };
}

test('discovery accepts an explicit portable Unicode path despite a PATH miss and preserves precedence', async t => {
  const f = await fixture(t);
  const explicit = await f.helper(join(f.root, '휴대 도구'));
  const configured = await f.helper(join(f.root, '환경 설정'));
  const pathHelper = await f.helper(join(f.root, 'path tools'));
  assert.deepEqual(await resolveCloudflared({ explicit, env: { PATH: '' } }), { path: explicit, source: 'argument' });
  const env = { PORTAL_CLOUDFLARED: configured, PATH: join(f.root, 'path tools') };
  assert.deepEqual(await resolveCloudflared({ explicit, env }), { path: explicit, source: 'argument' });
  assert.deepEqual(await resolveCloudflared({ env }), { path: configured, source: 'environment' });
  assert.deepEqual(await resolveCloudflared({ env: { PATH: env.PATH } }), { path: pathHelper, source: 'path' });
});

test('broken explicit and environment configuration never silently fall back to a working PATH helper', async t => {
  const f = await fixture(t);
  await f.helper(join(f.root, 'working'));
  const missing = join(f.root, 'missing portable', executable);
  for (const options of [
    { explicit: missing, env: { PORTAL_CLOUDFLARED: process.execPath, PATH: join(f.root, 'working') } },
    { env: { PORTAL_CLOUDFLARED: missing, PATH: join(f.root, 'working') } },
  ]) {
    const selected = await resolveCloudflared(options);
    assert.equal(selected.path, missing);
    let calls = 0;
    assert.throws(() => cachedAccessToken(selected.path, origin, path => {
      calls++; assert.equal(path, missing); throw errorWithCode('ENOENT');
    }), codeIs('CLOUDFLARED_NOT_FOUND'));
    assert.equal(calls, 1);
  }
  for (const explicit of ['', 'relative/cloudflared', 'bad\0path']) {
    await assert.rejects(resolveCloudflared({ explicit, env: { PORTAL_CLOUDFLARED: process.execPath } }), codeIs('INVALID_LOCAL_PATH'));
  }
});

test('PATH discovery skips current and relative entries and accepts only the exact platform executable', async t => {
  const f = await fixture(t);
  const directory = join(f.root, '한글 path');
  const expected = await f.helper(directory);
  // Windows checkout and tmpdir can be on different drives. Use the fixture's
  // own parent so the negative input is truly relative on both platforms.
  const relativeDirectory = relative(f.root, directory);
  assert.ok(relativeDirectory && !isAbsolute(relativeDirectory));
  await assert.rejects(resolveCloudflared({ env: { PATH: ['', '.', relativeDirectory].join(delimiter) } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  assert.deepEqual(await resolveCloudflared({ env: { Path: ['', '.', relativeDirectory, '"' + directory + '"'].join(delimiter) } }), {
    path: expected, source: 'path',
  });
  const namesOnly = join(f.root, 'wrong names');
  await f.helper(namesOnly, executable + '.backup');
  await f.helper(namesOnly, 'cloudflared.cmd');
  await assert.rejects(resolveCloudflared({ env: { PATH: namesOnly } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  const directoryOnly = join(f.root, 'directory only');
  await mkdir(join(directoryOnly, executable), { recursive: true });
  await assert.rejects(resolveCloudflared({ env: { PATH: directoryOnly } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  if (process.platform !== 'win32') {
    const nonExecutable = join(f.root, 'not executable');
    await f.helper(nonExecutable, executable, 0o600);
    await assert.rejects(resolveCloudflared({ env: { PATH: nonExecutable } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  }
});

test('PATH discovery enforces directory and character limits before any candidate can win', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'available');
  await f.helper(directory);
  await assert.rejects(resolveCloudflared({ env: { PATH: Array(256).fill('').join(delimiter) } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  await assert.rejects(resolveCloudflared({ env: { PATH: [directory, ...Array(256).fill('')].join(delimiter) } }), codeIs('CLOUDFLARED_DISCOVERY_LIMIT'));
  await assert.rejects(resolveCloudflared({ env: { PATH: 'x'.repeat(32768) } }), codeIs('CLOUDFLARED_NOT_FOUND'));
  await assert.rejects(resolveCloudflared({ env: { PATH: directory + delimiter + 'x'.repeat(32768) } }), codeIs('CLOUDFLARED_DISCOVERY_LIMIT'));
});

test('cached credentials invoke exactly one bounded non-shell cache read and never login', () => {
  const calls = [];
  const token = cachedAccessToken(process.execPath, origin, (...args) => { calls.push(args); return credential + '\r\n'; });
  assert.equal(token, credential);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [process.execPath, ['access', 'token', '--app=' + origin], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 16386, killSignal: 'SIGKILL', windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  }]);
  assert.equal(JSON.stringify(calls).includes(credential), false);
  for (const [budget, expected] of [[5000, 5000], [60000, 30000]]) {
    cachedAccessToken(process.execPath, origin, (_path, _args, options) => {
      assert.equal(options.timeout, expected); return credential;
    }, budget);
  }
});

test('cached credential failures distinguish missing executable, access, timeout and output limits without private diagnostics', () => {
  for (const [code, expected] of [
    ['ENOENT', 'CLOUDFLARED_NOT_FOUND'], ['EACCES', 'CLOUDFLARED_NOT_EXECUTABLE'], ['EPERM', 'CLOUDFLARED_NOT_EXECUTABLE'],
    ['ETIMEDOUT', 'ACCESS_CREDENTIAL_TIMEOUT'], ['ENOBUFS', 'ACCESS_CREDENTIAL_TOO_LARGE'], ['VENDOR_FAILURE', 'ACCESS_CREDENTIAL_UNAVAILABLE'],
  ]) {
    let calls = 0;
    assert.throws(() => cachedAccessToken(process.execPath, origin, () => { calls++; throw errorWithCode(code); }), codeIs(expected));
    assert.equal(calls, 1);
  }
  for (const token of ['', 'not-a-jwt', credential + '\n' + credential, 'a'.repeat(16385) + '.b.c', Buffer.from(credential)]) {
    assert.throws(() => cachedAccessToken(process.execPath, origin, () => token), codeIs('INVALID_ACCESS_CREDENTIAL'));
  }
});

test('doctor reports ready for a portable helper with no PATH and reads credentials once without remote operations', async t => {
  const f = await fixture(t), helper = await f.helper(join(f.root, '휴대 인증 도구'));
  const peer = injectedClient({ targets: [{ id: 'default', enabled: true, privatePath: 'PRIVATE_HELPER_DIAGNOSTIC' }] });
  let credentials = 0;
  const result = await diagnoseClient({ origin, cloudflared: helper, env: { PATH: '' }, openClient: peer.openClient,
    runCredential: path => { credentials++; assert.equal(path, helper); return credential; } });
  assert.equal(result.contract, 'portal-client-diagnostic-v1');
  assert.equal(result.state, 'ready');
  assert.equal(result.runtime.supported, true);
  assert.deepEqual(result.cloudflared, { path: helper, source: 'argument' });
  assert.deepEqual(result.targets, [{ id: 'default', enabled: true }]);
  assert.deepEqual(result.checks, [
    { stage: 'executable', state: 'configured' }, { stage: 'credential', state: 'available' },
    { stage: 'owner-session', state: 'connected' }, { stage: 'targets', state: 'readable' },
  ]);
  assert.deepEqual(peer.calls, ['open', 'connect', 'targets', 'close']);
  assert.equal(credentials, 1);
  noSideEffects(result);
});

test('doctor distinguishes undiscovered helper from unusable cache and never opens a portal for either', async () => {
  for (const scenario of [
    { cloudflared: undefined, code: 'CLOUDFLARED_NOT_FOUND', stage: 'executable', runs: 0 },
    { cloudflared: process.execPath, failure: 'ETIMEDOUT', code: 'ACCESS_CREDENTIAL_TIMEOUT', stage: 'credential', runs: 1 },
    { cloudflared: process.execPath, token: 'wrong-cache', code: 'INVALID_ACCESS_CREDENTIAL', stage: 'credential', runs: 1 },
    { cloudflared: process.execPath, failure: 'ENOENT', code: 'CLOUDFLARED_NOT_FOUND', stage: 'credential', runs: 1 },
  ]) {
    let runs = 0, opens = 0;
    const result = await diagnoseClient({ origin, cloudflared: scenario.cloudflared, env: { PATH: '' },
      runCredential: () => { runs++; if (scenario.failure) throw errorWithCode(scenario.failure); return scenario.token; },
      openClient: () => { opens++; assert.fail('No portal access before credentials are available'); } });
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.checks.at(-1), { stage: scenario.stage, state: 'blocked', error: scenario.code });
    assert.equal(runs, scenario.runs); assert.equal(opens, 0);
    noSideEffects(result);
  }
});

test('doctor separates owner authentication, mode and portal availability failures and closes once', async () => {
  for (const [stage, code] of [['owner-session', 'OWNER_REAUTH_REQUIRED'], ['owner-session', 'ACCESS_MODE_REQUIRED'], ['targets', 'PORTAL_READ_FAILED']]) {
    const failure = errorWithCode(code);
    const peer = injectedClient(stage === 'targets' ? { targetsFailure: failure } : { connectFailure: failure });
    let runs = 0;
    const result = await diagnoseClient({ origin, cloudflared: process.execPath, env: {}, openClient: peer.openClient,
      runCredential: () => { runs++; return credential; } });
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.checks.at(-1), { stage, state: 'blocked', error: code });
    assert.equal(runs, 1);
    assert.deepEqual(peer.calls, stage === 'targets' ? ['open', 'connect', 'targets', 'close'] : ['open', 'connect', 'close']);
    noSideEffects(result);
  }
});

test('doctor rejects malformed or oversized target responses instead of claiming readiness', async () => {
  for (const targets of [undefined, {}, [{ id: 'bad!', enabled: true }], [{ id: 'default' }], [null], Array(257).fill({ id: 'default', enabled: true })]) {
    const peer = injectedClient();
    const openClient = options => {
      const client = peer.openClient(options);
      client.targets = async () => { peer.calls.push('targets'); return { targets }; };
      return client;
    };
    const result = await diagnoseClient({ origin, cloudflared: process.execPath, env: {}, openClient, runCredential: () => credential });
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.checks.at(-1), { stage: 'targets', state: 'blocked', error: 'INVALID_PORTAL_RESPONSE' });
    assert.deepEqual(peer.calls, ['open', 'connect', 'targets', 'close']);
    noSideEffects(result);
  }
});

test('doctor does not report readiness when temporary session cleanup is unknown', async () => {
  const peer = injectedClient();
  const result = await diagnoseClient({ origin, cloudflared: process.execPath, env: {}, runCredential: () => credential,
    openClient: options => {
      const client = peer.openClient(options);
      client.close = async () => { peer.calls.push('close'); throw errorWithCode('PORTAL_RESULT_UNKNOWN'); };
      return client;
    } });
  assert.equal(result.state, 'blocked');
  assert.equal(result.sessionCleanup, 'unknown');
  assert.deepEqual(result.checks.at(-1), { stage: 'session-cleanup', state: 'blocked', error: 'OWNER_SESSION_CLEANUP_UNKNOWN' });
  assert.deepEqual(peer.calls, ['open', 'connect', 'targets', 'close']);
  noSideEffects(result);
});

test('CLI doctor uses injected environment discovery and returns public ready or blocked JSON with correct exit codes', async t => {
  const originalFetch = globalThis.fetch, requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method });
    assert.equal(options.headers['cf-access-token'], credential);
    if (path === '/api/session') return Response.json({ mode: 'access' });
    if (path === '/api/session/start') return Response.json({ connected: true }, { headers: {
      'Set-Cookie': '__Host-ssh_admin_session=' + 'f'.repeat(64) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60',
    } });
    if (path === '/api/targets') return Response.json({ targets: [{ id: 'default', enabled: true }] });
    if (path === '/api/session/logout') return Response.json({ connected: false });
    assert.fail('Doctor must not submit file, command or approval operations: ' + path);
  };
  async function invoke(env, run) {
    let stdout = '', stderr = '', stdinReads = 0;
    const input = { async *[Symbol.asyncIterator]() { stdinReads++; assert.fail('doctor never consumes private stdin'); } };
    const code = await main(['--origin', origin, 'doctor'], input, { write: s => { stdout += s; } },
      { write: s => { stderr += s; } }, run, env);
    assert.equal(stderr, ''); assert.equal(stdinReads, 0);
    const value = JSON.parse(stdout);
    noSideEffects(value);
    return { code, value };
  }
  let credentials = 0;
  const ready = await invoke({ PATH: '', PORTAL_CLOUDFLARED: process.execPath }, path => {
    credentials++; assert.equal(path, process.execPath); return credential;
  });
  assert.equal(ready.code, 0); assert.equal(ready.value.state, 'ready');
  assert.equal(ready.value.cloudflared.source, 'environment'); assert.equal(credentials, 1);
  assert.deepEqual(requests, [
    { path: '/api/session', method: 'GET' }, { path: '/api/session/start', method: 'POST' },
    { path: '/api/targets', method: 'GET' }, { path: '/api/session/logout', method: 'POST' },
  ]);
  requests.length = 0;
  const blocked = await invoke({ PATH: '' }, () => { assert.fail('No helper must mean no credential read'); });
  assert.equal(blocked.code, 1); assert.equal(blocked.value.state, 'blocked');
  assert.equal(blocked.value.checks.at(-1).error, 'CLOUDFLARED_NOT_FOUND');
  assert.deepEqual(requests, []);
});
