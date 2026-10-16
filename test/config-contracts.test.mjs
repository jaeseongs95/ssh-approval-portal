import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseSettings, validateOrigin, validatedPort, settingsContract } from '../src/adapters/config/settings.mjs';
import { loadSecrets, parseSecretText } from '../src/adapters/config/secrets.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';
import { generateSecrets } from '../scripts/generate-secrets.mjs';
import { checkHealth } from '../scripts/healthcheck.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUploadHosts, matchesUploadHost, UPLOAD_HOSTS_MAX_BYTES } from '../src/adapters/config/upload-hosts.mjs';

const origin = 'https://admin.example.test';
const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: origin };

test('runtime upload settings share exact and wildcard policy vectors with deployment tools', () => {
  for (const { value, expected, valid } of settingsContract.uploadHostVectors) {
    if (valid === false) {
      assert.throws(() => parseUploadHosts(value), undefined, JSON.stringify(value));
      assert.throws(() => parseSettings({ ...env, BRIDGE_UPLOAD_SOURCE_HOSTS: value }));
    } else {
      assert.deepEqual(parseUploadHosts(value), expected);
      assert.deepEqual(parseSettings({ ...env, BRIDGE_UPLOAD_SOURCE_HOSTS: value }).uploadHosts, expected);
    }
  }
  for (const { pattern, host, allowed } of settingsContract.uploadHostMatchVectors) {
    assert.equal(matchesUploadHost(host, parseUploadHosts(pattern)), allowed, `${pattern}: ${host}`);
  }
  const script = fileURLToPath(new URL('../scripts/validate-upload-hosts.mjs', import.meta.url));
  for (const [input, expected] of [[' Files.Example.test,*.Example.test ', 'files.example.test,*.example.test'], ['', ''], ['*', null], ['x'.repeat(UPLOAD_HOSTS_MAX_BYTES + 1), null]]) {
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 5000, maxBuffer: UPLOAD_HOSTS_MAX_BYTES + 256 });
    assert.ifError(result.error);
    assert.equal(result.status, expected === null ? 1 : 0);
    assert.equal(result.stdout, expected ?? '');
    assert.equal(result.stderr, expected === null ? 'Upload source validation failed.\n' : '');
  }
});

test('canonical origin and supported port vectors are identical configuration contracts', () => {
  for (const { value, valid } of settingsContract.originVectors) {
    if (valid) assert.equal(validateOrigin(value), value);
    else assert.throws(() => validateOrigin(value), undefined, JSON.stringify(value));
  }
  for (const { value, valid } of settingsContract.portVectors) {
    if (valid) assert.equal(validatedPort(value), Number(value));
    else assert.throws(() => validatedPort(value), undefined, JSON.stringify(value));
  }
  const defaults = parseSettings(env);
  assert.equal(defaults.mcpPort, 39124); assert.equal(defaults.adminPort, 39125);
  assert.equal(defaults.uiEnabled, false); assert.equal(defaults.maxBytes, 64 * 1024 * 1024);
  const custom = parseSettings({ ...env, BRIDGE_MCP_PORT: '40001', BRIDGE_ADMIN_PORT: '40002' });
  assert.equal(custom.mcpPort, 40001); assert.equal(custom.adminPort, 40002);
  for (const { value, valid } of settingsContract.originVectors) if (!valid) assert.throws(() => parseSettings({ ...env, BRIDGE_ADMIN_ORIGIN: value }));
  assert.throws(() => parseSettings({ ...env, BRIDGE_ADMIN_TOKEN: env.BRIDGE_MCP_TOKEN }));
  assert.throws(() => validateOrigin('https://' + 'a'.repeat(settingsContract.originMaxBytes)));
});

test('Node24 origin CLI delegates to the same validator with bounded exact stdin and stdout', () => {
  const script = fileURLToPath(new URL('../scripts/validate-origin.mjs', import.meta.url));
  const vectors = settingsContract.originVectors.filter(x => x.value.includes('xn--'));
  for (const { value, valid } of [...vectors, { value: 'x'.repeat(settingsContract.originMaxBytes + 1), valid: false }]) {
    const result = spawnSync(process.execPath, [script], { input: value, encoding: 'utf8', timeout: 5000, maxBuffer: settingsContract.originMaxBytes + 256 });
    assert.ifError(result.error);
    assert.equal(result.status, valid ? 0 : 1, JSON.stringify(value.slice(0, 80)));
    assert.equal(result.stdout, valid ? value : '');
    assert.equal(result.stderr, valid ? '' : 'Origin validation failed.\n');
  }
});

test('admin authorization preserves mode, maintenance, Origin and capability exception matrix', async () => {
  const download = '/downloads/' + 'a'.repeat(48) + '/' + 'b'.repeat(32);
  const req = (url, method = 'GET', headers = {}) => ({ url, method, headers });
  const bearer = { authorization: 'Bearer fixture-admin' }, post = { ...bearer, origin };
  const configs = {
    token: { adminAccess: { mode: 'token' }, adminToken: env.BRIDGE_ADMIN_TOKEN, adminOrigin: origin },
    access: { adminAccess: { mode: 'access', authenticated: async r => r.headers.owner === 'signed-owner' }, adminToken: env.BRIDGE_ADMIN_TOKEN, adminOrigin: origin },
  };
  const cases = [
    ['token', req('/'), true, 'static'], ['token', req('/app.js'), true, 'static'],
    ['token', req('/api/session'), true, 'session'], ['token', req(download), true, 'download'],
    ['token', req(download, 'HEAD'), true, 'download'],
    ['token', req('/api/requests'), false, 'api', 401], ['token', req('/api/requests', 'GET', bearer), true, 'api'],
    ['token', req('/api/' + 'a'.repeat(48) + '/approve', 'POST', post), true, 'api'],
    ['token', req('/api/' + 'a'.repeat(48) + '/approve', 'POST', bearer), false, 'api', 403],
    ['access', req('/api/session', 'GET', bearer), false, 'session', 401],
    ['access', req(download, 'GET', bearer), false, 'download', 401],
    ['access', req('/', 'GET', { owner: 'signed-owner' }), true, 'static'],
    ['access', req('/api/session', 'GET', { owner: 'signed-owner' }), true, 'session'],
    ['access', req(download, 'HEAD', { owner: 'signed-owner' }), true, 'download'],
    ['access', req('/api/' + 'a'.repeat(48) + '/approve', 'POST', { owner: 'signed-owner', origin }), true, 'api'],
    ['access', req('/api/' + 'a'.repeat(48) + '/approve', 'POST', { owner: 'signed-owner', origin: 'https://other.example.test' }), false, 'api', 403],
    ['access', req('/api/maintenance/reserve', 'POST', { owner: 'signed-owner', origin }), false, 'maintenance', 401],
    ['access', req('/api/maintenance/reserve', 'POST', post), true, 'maintenance'],
    ['access', req('/api/maintenance/release', 'GET', bearer), false, 'maintenance', 403],
    ['token', req('/unknown', 'GET', bearer), false, 'api', 403],
  ];
  for (const [mode, request, allowed, routeKind, status] of cases) {
    const actual = await authorizeAdminRequest(request, configs[mode]);
    assert.deepEqual(actual, { allowed, ...(status ? { status } : {}), routeKind }, `${mode} ${request.method} ${request.url}`);
  }
});

test('native secret generation preserves protected bytes and ownership with atomic replacement', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'portal-config-')), file = join(root, 'secrets.env');
  const original = '# owner settings\r\nBRIDGE_ADMIN_TOKEN=fixture-existing\r\nBRIDGE_UI_ENABLED=true\r\nBRIDGE_ADMIN_AUTH_MODE=access\r\nBRIDGE_ACCESS_TEAM_DOMAIN=https://fixture.cloudflareaccess.com\r\nBRIDGE_ACCESS_AUD=fixture-audience\r\nBRIDGE_ACCESS_OWNER_EMAILS=fixture@example.test\r\n';
  try {
    await fs.writeFile(file, original, { mode: 0o600 });
    const before = await fs.stat(file);
    await generateSecrets(file, origin);
    const text = await fs.readFile(file, 'utf8'), after = await fs.stat(file);
    assert.ok(text.startsWith(original)); assert.equal(text.replaceAll('\r\n', '').includes('\n'), false);
    const settings = await loadSecrets({}, file);
    assert.equal(settings.BRIDGE_ADMIN_TOKEN, 'fixture-existing'); assert.equal(settings.BRIDGE_UI_ENABLED, 'true');
    assert.equal(settings.BRIDGE_ADMIN_AUTH_MODE, 'access'); assert.equal(settings.BRIDGE_ACCESS_AUD, 'fixture-audience');
    assert.equal(settings.BRIDGE_ACCESS_TEAM_DOMAIN, 'https://fixture.cloudflareaccess.com');
    assert.equal(settings.BRIDGE_ACCESS_OWNER_EMAILS, 'fixture@example.test');
    assert.equal(settings.BRIDGE_ADMIN_ORIGIN, origin); assert.match(settings.BRIDGE_MCP_TOKEN, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') { assert.equal(after.mode & 0o777, 0o600); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); }
    await generateSecrets(file, 'https://ignored.example.test');
    assert.equal(await fs.readFile(file, 'utf8'), text, 'existing settings are not regenerated');
    assert.deepEqual(await fs.readdir(root), ['secrets.env']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native staging write and rename failures preserve previous configuration and clean staging', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'portal-config-fail-')), file = join(root, 'secrets.env');
  const original = 'BRIDGE_ADMIN_TOKEN=fixture-existing\n';
  try {
    await fs.writeFile(file, original, { mode: 0o600 });
    for (const point of ['write', 'rename']) {
      const io = { ...fs, async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        if (path !== file && dirname(path) === root && args[0] === 'wx' && point === 'write') {
          handle.writeFile = async () => { throw Object.assign(Error('synthetic staging failure'), { code: 'ENOSPC' }); };
        }
        return handle;
      }, async rename(...args) {
        if (point === 'rename') throw Object.assign(Error('synthetic rename failure'), { code: 'EIO' });
        return fs.rename(...args);
      } };
      await assert.rejects(generateSecrets(file, origin, { io }));
      assert.equal(await fs.readFile(file, 'utf8'), original);
      assert.deepEqual(await fs.readdir(root), ['secrets.env']);
    }
    await assert.rejects(generateSecrets(file, origin + '?owner=1'));
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('healthcheck uses configured port and requires healthy JSON without disclosing settings', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url, options }); return { ok: true, json: async () => ({ healthy: true, adminAuthMode: 'access' }) }; };
  assert.equal(await checkHealth({ env: { BRIDGE_MCP_PORT: '40001' }, fetchImpl, expectedAuthMode: 'access' }), true);
  assert.equal(seen[0].url, 'http://127.0.0.1:40001/health'); assert.ok(seen[0].options.signal);
  await assert.rejects(checkHealth({ env: {}, expectedAuthMode: 'token', fetchImpl }));
  await assert.rejects(checkHealth({ env: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ healthy: false }) }) }));
  await assert.rejects(checkHealth({ env: { BRIDGE_MCP_PORT: '65536' }, fetchImpl }));
  assert.equal(parseSecretText('SSH_MCP_FIXTURE2_KEY=\"private-value\"\n').SSH_MCP_FIXTURE2_KEY, 'private-value');
});

test('display names are optional public labels, bounded and free of control/formatting characters', () => {
  const env = { BRIDGE_MCP_TOKEN: 'mcp', BRIDGE_ADMIN_TOKEN: 'admin', BRIDGE_ADMIN_ORIGIN: 'https://test-admin.example' };
  const legacy = parseSettings(env);
  assert.equal(legacy.bridgeDisplayName, 'test-admin.example'); assert.equal(legacy.targetDisplayName, 'SSH');
  const configured = parseSettings({ ...env, BRIDGE_DISPLAY_NAME: '  시험 중계기  ', BRIDGE_TARGET_DISPLAY_NAME: '<ARM & production>' });
  assert.equal(configured.bridgeDisplayName, '시험 중계기'); assert.equal(configured.targetDisplayName, '<ARM & production>');
  assert.equal(parseSettings({ ...env, BRIDGE_DISPLAY_NAME: 'A'.repeat(80) }).bridgeDisplayName.length, 80);
  for (const key of ['BRIDGE_DISPLAY_NAME', 'BRIDGE_TARGET_DISPLAY_NAME']) {
    for (const value of ['A'.repeat(81), 'spoof\nname', 'spoof\u202ename', 'name\u0000', 'name\u2028break', 123]) {
      assert.throws(() => parseSettings({ ...env, [key]: value }), /Display names/);
    }
    assert.ok(settingsContract.allowedKeys.includes(key));
  }
});
