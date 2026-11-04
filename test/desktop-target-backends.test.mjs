import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetDesktops } from '../src/adapters/desktop/target-desktops.mjs';
import { parseTargets } from '../src/adapters/config/targets.mjs';

const revision = 'a'.repeat(64);
const binding = { targetId: 'fixture', targetRevision: revision, ownerId: 'fixture-owner', epoch: 1 };
function fixture(desktop, options = {}) {
  const runtime = { id: binding.targetId, revision, desktop, writeProfile: 'fixture-write', verify() {} };
  const calls = [];
  const deps = { targets: { select(id) { assert.equal(id, runtime.id); return runtime; } },
    registry: { getProfile() { return { trustedHostKey: 'fixture-pin', user: 'fixture' }; } }, maintenance: () => false,
    openDesktopChannel: async () => { calls.push('channel'); throw Error('fixture channel refused'); },
    openDesktopProcessChannel: async () => assert.fail('unexpected process'),
    resolver: { resolve: async () => { calls.push('credential'); throw Error('PRIVATE_SECRET'); } },
    readRdpCapabilities: async () => ({ available: true, executable: '/usr/bin/xfreerdp3' }), ...options };
  return { service: createTargetDesktops(deps), runtime, calls, deps };
}

test('target config selects platform-supported backends and canonical private references', () => {
  const parse = (platform, desktop) => parseTargets(JSON.stringify([{ id: 'fixture', displayName: 'fixture',
    readProfile: 'fixture-read', writeProfile: 'fixture-write', credentialRevision: 'v1', platform, desktop }]));
  assert.equal(parse('linux', { enabled: true, backend: 'xvnc' })[0].desktop.backend, 'xvnc');
  assert.equal(parse('windows', { enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' })[0].desktop.backend, 'rdp');
  assert.equal(parse('windows', { enabled: true, port: 5901 })[0].desktop.port, 5901);
  for (const [platform, desktop] of [
    ['windows', { enabled: true, backend: 'xvnc' }],
    ['linux', { enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' }],
    ['windows', { enabled: true, backend: 'rdp', credentialRef: 'plaintext' }],
    ['windows', { enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp', port: 3389 }],
    ['linux', { enabled: true, backend: 'xvnc', source: 'arbitrary' }],
    ['linux', { enabled: true, backend: 'xvnc', width: 4096, height: 4096 }],
  ]) assert.throws(() => parse(platform, desktop));
});

test('discovery distinguishes configured backend from available native support without opening a session', async () => {
  const f = fixture({ enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' },
    { readRdpCapabilities: async () => ({ available: false, executable: null }) });
  const value = await f.service.capabilities(binding);
  assert.equal(value.status, 'backend_unavailable');
  assert.equal(value.reason, 'DESKTOP_RDP_CLIENT_UNAVAILABLE');
  assert.equal(value.requiresUserClient, false); assert.deepEqual(f.calls, []);
  f.runtime.desktop = { enabled: false, backend: 'xvnc' };
  assert.equal((await f.service.capabilities(binding)).status, 'disabled');
});

test('managed Linux leases are distinct while attached displays and Windows hosts remain exclusive', () => {
  const f = fixture({ enabled: true, backend: 'xvnc' });
  assert.notEqual(f.service.leaseKey(binding), f.service.leaseKey({ ...binding, epoch: 2 }));
  f.runtime.desktop = { enabled: true, port: 5901 };
  assert.equal(f.service.leaseKey(binding), f.service.leaseKey({ ...binding, epoch: 2 }));
  f.runtime.desktop = { enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' };
  const first = f.service.leaseKey(binding);
  f.runtime.desktop.credentialRef = 'secret://fixture/alias';
  assert.equal(first, f.service.leaseKey({ ...binding, epoch: 3 }));
});

test('target changes and maintenance prevent native dispatch and credential reads', async () => {
  for (const options of [{ maintenance: () => true }, {}]) {
    const f = fixture({ enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' }, options);
    if (!options.maintenance) f.runtime.revision = 'b'.repeat(64);
    await assert.rejects(f.service.adapter.open({ binding }), { code: options.maintenance ? 'MAINTENANCE_ACTIVE' : 'DESKTOP_STALE_TARGET' });
    assert.deepEqual(f.calls, []);
  }
});

test('failed native capability or pinned SSH establishment never requests an RDP credential', async () => {
  const config = { enabled: true, backend: 'rdp', credentialRef: 'secret://fixture/rdp' };
  const missing = fixture(config, { readRdpCapabilities: async () => ({ available: false }) });
  await assert.rejects(missing.service.adapter.open({ binding }), { code: 'DESKTOP_RDP_CLIENT_UNAVAILABLE' });
  assert.deepEqual(missing.calls, []);
  const refused = fixture(config);
  await assert.rejects(refused.service.adapter.open({ binding }), { code: 'DESKTOP_RDP_OPEN_FAILED' });
  assert.deepEqual(refused.calls, ['channel']);
  const unpinned = fixture(config, { registry: { getProfile: () => ({}) } });
  await assert.rejects(unpinned.service.adapter.open({ binding }), { code: 'DESKTOP_RDP_IDENTITY_UNVERIFIED' });
  assert.deepEqual(unpinned.calls, []);
});
