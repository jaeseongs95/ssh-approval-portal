import test from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism, tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capacityDefaults, parseCapacity, validateCapacity } from '../src/adapters/config/capacity.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
import { parseTargets, resolveTargets } from '../src/adapters/config/targets.mjs';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';
import { generateSecrets } from '../scripts/generate-secrets.mjs';

const env = { BRIDGE_MCP_TOKEN: 'capacity-fixture-mcp', BRIDGE_ADMIN_TOKEN: 'capacity-fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://admin.example.test' };
const entry = (id, patch = {}) => ({ id, displayName: id, readProfile: 'shared-read', writeProfile: 'shared-write', credentialRevision: 'v1', ...patch });
const registry = { getProfile: name => ({ host: 'shared.example.test', port: 22, user: 'fixture', trustedHostKey: 'SHA256:fixture', readOnly: name === 'shared-read', auth: 'key', keyRef: 'fixture-key' }) };

test('capacity defaults follow available Relay CPUs and permit explicit positive safe integers', () => {
  assert.deepEqual(capacityDefaults(2), { availableCpus: 2, queueCapacity: 20, maxConcurrency: 2 });
  const settings = parseSettings(env), cpus = availableParallelism();
  assert.equal(settings.availableCpus, cpus);
  assert.equal(settings.queueCapacity, cpus * 10);
  assert.equal(settings.maxConcurrency, cpus);
  const custom = parseSettings({ ...env, BRIDGE_QUEUE_CAPACITY: '2001', BRIDGE_MAX_CONCURRENCY: '65', BRIDGE_REQUEST_CAPACITY: '1' });
  assert.equal(custom.queueCapacity, 2001); assert.equal(custom.maxConcurrency, 65); assert.equal(custom.requestCapacity, 1);
  for (const value of ['', '0', '-1', '1.5', '01', '1e3', ' 2', '2\n', '9007199254740992', 2, null]) assert.throws(() => parseCapacity(value));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '2', null]) assert.throws(() => validateCapacity(value));
  for (const key of ['BRIDGE_QUEUE_CAPACITY', 'BRIDGE_MAX_CONCURRENCY']) {
    for (const value of ['0', '1.5', '9007199254740992', 2, null]) assert.throws(() => parseSettings({ ...env, [key]: value }));
  }
});

test('Docker installation default CLI uses the same Relay CPU defaults', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/capacity-defaults.mjs', import.meta.url))], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const { queueCapacity, maxConcurrency } = capacityDefaults();
  assert.deepEqual(JSON.parse(result.stdout), { BRIDGE_QUEUE_CAPACITY: String(queueCapacity), BRIDGE_MAX_CONCURRENCY: String(maxConcurrency) });
});

test('target overrides inherit global values while retaining nullable startup configuration', () => {
  const targets = parseTargets(JSON.stringify([entry('inherited'), entry('nullable', { queueCapacity: null, maxConcurrency: null }), entry('override', { queueCapacity: 7, maxConcurrency: 3 })]));
  const resolved = resolveTargets({ ...parseSettings(env), queueCapacity: 20, maxConcurrency: 2, targets }, registry);
  assert.equal(targets[1].queueCapacity, null);
  assert.deepEqual(resolved.map(t => [t.queueCapacity, t.maxConcurrency]), [[20, 2], [20, 2], [7, 3]]);
  assert.ok(Object.isFrozen(targets[1])); assert.ok(Object.isFrozen(resolved[1]));
  for (const key of ['queueCapacity', 'maxConcurrency']) for (const value of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseTargets(JSON.stringify([entry('invalid', { [key]: value })])));
  }
});

test('target count and profile aliases retain payload and identity safeguards', () => {
  const targets = parseTargets(JSON.stringify(Array.from({ length: 33 }, (_, i) => entry('target' + i))));
  const resolved = resolveTargets({ ...parseSettings(env), targets }, registry);
  assert.equal(resolved.length, 33);
  assert.notEqual(resolved[0].revision, resolved[1].revision);
  assert.notEqual(resolved[0].identity.targetId, resolved[1].identity.targetId);
  assert.throws(() => parseTargets(' '.repeat(65537)));
  assert.throws(() => parseTargets(JSON.stringify([entry('duplicate'), entry('duplicate')])));
  for (const patch of [{ trustedHostKey: '' }, { trustedHostKey: 'SHA256:other' }, { auth: 'password' }, { keyRef: 'other-key' }, { host: 'other.example.test' }]) {
    assert.throws(() => resolveTargets({ ...parseSettings(env), targets }, { getProfile: name => ({ ...registry.getProfile(name), ...(name === 'shared-read' ? patch : {}) }) }));
  }
  assert.throws(() => resolveTargets({ ...parseSettings(env), targets }, { getProfile: name => ({ ...registry.getProfile(name), trustedHostKey: '' }) }));
});

test('desktop settings require an explicit immutable configuration bound to the target revision', () => {
  const resolve = desktop => resolveTargets({ ...parseSettings(env), targets: parseTargets(JSON.stringify([entry('desktop', desktop === undefined ? {} : { desktop })])) }, registry)[0];
  assert.equal(resolve().desktop, undefined);
  const enabled = resolve({ enabled: true, port: 5901 });
  assert.deepEqual(enabled.desktop, { enabled: true, port: 5901 });
  assert.ok(Object.isFrozen(enabled.desktop));
  assert.notEqual(enabled.revision, resolve({ enabled: false, port: 5901 }).revision);
  assert.notEqual(enabled.revision, resolve({ enabled: true, port: 5902 }).revision);
  for (const port of [1, 65535]) assert.equal(resolve({ enabled: false, port }).desktop.port, port);
  for (const desktop of [null, [], true, {}, { enabled: true }, { port: 5900 }, { enabled: 'true', port: 5900 },
    { enabled: true, port: 0 }, { enabled: true, port: 65536 }, { enabled: true, port: 1.5 }, { enabled: true, port: '5900' },
    { enabled: true, port: 5900, host: 'unregistered.example.test' }]) assert.throws(() => resolve(desktop));
});

test('initial installation persists CPU defaults and upgrades preserve saved capacities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-install-')), file = join(root, 'fixture.env');
  try {
    await generateSecrets(file, env.BRIDGE_ADMIN_ORIGIN, { availableCpus: 2 });
    const first = await readFile(file, 'utf8'), parsed = parseSecretText(first);
    assert.equal(parsed.BRIDGE_QUEUE_CAPACITY, '20'); assert.equal(parsed.BRIDGE_MAX_CONCURRENCY, '2');
    await generateSecrets(file, env.BRIDGE_ADMIN_ORIGIN, { availableCpus: 32 });
    assert.equal(await readFile(file, 'utf8'), first);
    const explicit = '# administrator settings\r\nBRIDGE_QUEUE_CAPACITY=1234\r\nBRIDGE_MAX_CONCURRENCY=123\r\n';
    await writeFile(file, explicit, { mode: 0o600 });
    await generateSecrets(file, env.BRIDGE_ADMIN_ORIGIN, { availableCpus: 4 });
    const updated = await readFile(file, 'utf8');
    assert.ok(updated.startsWith(explicit));
    assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
    assert.equal(parseSecretText(updated).BRIDGE_QUEUE_CAPACITY, '1234');
    assert.equal(parseSecretText(updated).BRIDGE_MAX_CONCURRENCY, '123');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installation fills only missing capacity fields and refuses invalid saved values atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-upgrade-')), file = join(root, 'fixture.env');
  try {
    await writeFile(file, 'BRIDGE_QUEUE_CAPACITY=7\n', { mode: 0o600 });
    await generateSecrets(file, env.BRIDGE_ADMIN_ORIGIN, { availableCpus: 4 });
    const parsed = parseSecretText(await readFile(file, 'utf8'));
    assert.equal(parsed.BRIDGE_QUEUE_CAPACITY, '7'); assert.equal(parsed.BRIDGE_MAX_CONCURRENCY, '4');
    const invalid = 'BRIDGE_QUEUE_CAPACITY=0\n';
    await writeFile(file, invalid, { mode: 0o600 });
    await assert.rejects(generateSecrets(file, env.BRIDGE_ADMIN_ORIGIN, { availableCpus: 4 }));
    assert.equal(await readFile(file, 'utf8'), invalid);
  } finally { await rm(root, { recursive: true, force: true }); }
});
