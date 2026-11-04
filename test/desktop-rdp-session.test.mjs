import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { nativeRdpExecutable } from '../src/adapters/desktop/rdp-runtime.mjs';
import { createRdpSessionDesktopAdapter, rdpClientCapabilities, rdpSessionPlan,
  writeRdpCredentialBootstrap } from '../src/adapters/desktop/rdp-session.mjs';

const config = { credentialRef: 'secret://fixture/windows-agent' };
const capabilities = { available: true, executable: nativeRdpExecutable,
  executableSha256: 'a'.repeat(64), patchDigest: 'b'.repeat(64) };
const credentials = { username: 'fixture-user', domain: '', password: 'fixture-private-password' };
const binding = { targetId: 'windows', targetRevision: 'a'.repeat(64), epoch: 1 };
const identity = { mode: 'pinned-ssh-loopback', hostKeyVerified: true,
  remoteHost: '127.0.0.1', remotePort: 3389, targetId: binding.targetId, targetRevision: binding.targetRevision };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  const seen = { credentials: 0, displayClosed: 0, tunnelClosed: 0, released: 0, bootstrap: null };
  const display = { observe: async () => ({ width: 1280, height: 800, geometryRevision: 1, data: Buffer.from('fixture') }),
    input: async actions => { seen.actions = actions; }, release: async () => { seen.released++; return { sent: true }; },
    close: async () => { seen.displayClosed++; return { sessionState: 'terminated', nativeInputState: 'detached', nativeReleaseSent: true }; } };
  const options = { config, readClientCapabilities: async () => capabilities,
    openTunnel: async args => { seen.tunnel = args; return { host: '127.0.0.1', port: 33001, close: async () => { seen.tunnelClosed++; } }; },
    credentialProvider: async args => { seen.credentials++; seen.credentialRequest = args; return credentials; },
    verifyServerIdentity: async ({ endpoint }) => ({ ...identity, endpoint }),
    openSession: async args => {
      seen.session = args;
      await args.writeBootstrap(new Writable({ write(bytes, _encoding, callback) { seen.bootstrap = Buffer.from(bytes); callback(); } }));
      return display;
    }, ...overrides };
  const adapter = createRdpSessionDesktopAdapter(options);
  return { seen, display, options, adapter: { open: args => adapter.open({ binding, ...args }) } };
}

test('RDP relay: native/display readiness is distinct from Windows logon and close is a detach receipt', async () => {
  const f = fixture();
  const desktop = await f.adapter.open({ binding });
  assert.equal(f.seen.tunnel.host, '127.0.0.1'); assert.equal(f.seen.tunnel.port, 3389);
  assert.equal(f.seen.session.application.port, 33001);
  assert.equal(f.seen.session.application.executable, nativeRdpExecutable);
  assert.equal(f.seen.session.application.executableSha256, capabilities.executableSha256);
  assert.equal(f.seen.session.application.patchDigest, capabilities.patchDigest);
  assert.equal(f.seen.session.application.certificateMode, 'ssh-tunnel');
  assert.equal(JSON.stringify(f.seen.session.application).includes(credentials.password), false);
  assert.deepEqual(JSON.parse(f.seen.bootstrap), credentials);
  assert.equal(f.seen.credentials, 1); assert.equal(f.seen.credentialRequest.credentialRef, 'secret://fixture/windows-agent');
  assert.equal(desktop.lifecycle, 'managed');
  assert.deepEqual(desktop.nativeReadiness, { display: 'ready', client: 'started', windows: 'unverified' });
  const state = await desktop.readState();
  assert.equal(state.state, 'transport_ready'); assert.equal(state.sessionBindingVerified, false);
  assert.equal(state.inputAllowed, true); assert.equal(state.osSessionId, null);
  assert.match(state.sessionRef, /^rdp:/); assert.match(state.resourceGeneration, /^[a-f0-9]{64}$/);
  assert.equal((await desktop.observe()).data.toString(), 'fixture');
  await desktop.release(); assert.equal(f.seen.released, 1);
  const receipt = await desktop.close();
  assert.deepEqual(receipt, { sessionState: 'unknown', remoteSessionState: 'unknown', outerSessionState: 'terminated',
    nativeInputState: 'detached', nativeReleaseSent: true, logout: false, mode: 'detach' });
  assert.deepEqual(await desktop.close(), receipt);
  assert.equal(f.seen.displayClosed, 1); assert.equal(f.seen.tunnelClosed, 1);
  assert.throws(() => desktop.observe(), { code: 'DESKTOP_CLOSED' });
});

test('RDP relay refuses absent client and mismatched identity before asking for credentials', async () => {
  const absent = fixture({ readClientCapabilities: async () => ({ available: false }) });
  await assert.rejects(absent.adapter.open(), { code: 'DESKTOP_RDP_CLIENT_UNAVAILABLE' });
  assert.equal(absent.seen.tunnel, undefined); assert.equal(absent.seen.credentials, 0);
  for (const broken of [{}, { ...identity, mode: 'raw-tcp' }, { ...identity, hostKeyVerified: false },
    { ...identity, targetRevision: 'b'.repeat(64) }, { ...identity, remoteHost: 'another.test' }, { ...identity, remotePort: 3390 }]) {
    const f = fixture({ verifyServerIdentity: async ({ endpoint }) => ({ ...broken, endpoint }) });
    await assert.rejects(f.adapter.open(), { code: 'DESKTOP_RDP_IDENTITY_UNVERIFIED' });
    assert.equal(f.seen.credentials, 0); assert.equal(f.seen.session, undefined); assert.equal(f.seen.tunnelClosed, 1);
  }
});

test('RDP relay validates public plan and restricts the tunnel to loopback', () => {
  assert.equal(rdpSessionPlan({ config, endpoint: { host: '127.0.0.1', port: 33001 }, capabilities }).kind, 'rdp');
  for (const endpoint of [{ host: '0.0.0.0', port: 3389 }, { host: '127.0.0.1', port: 0 }, { host: 'remote.test', port: 3389 }]) {
    assert.throws(() => rdpSessionPlan({ config, endpoint, capabilities }), { code: 'DESKTOP_RDP_INVALID_TUNNEL' });
  }
  for (const credentialRef of ['windows-agent', '../secret', 'secret://local-file/../key', 'secret://LOCAL/key',
    'secret://fixture/key/child', 'secret://fixture/key?query']) {
    assert.throws(() => fixture({ config: { credentialRef } }), { code: 'DESKTOP_INVALID_CONFIG' });
  }
});

test('RDP client capability requires the private framed protocol, upstream pin and executable digest', () => {
  const probe = { platform: 'linux', ...capabilities, native: { protocol: 'ags-native-input/1',
    upstreamCommit: 'bf217a504e54cc719880c228e82353382cd7d4fa', patchDigest: capabilities.patchDigest } };
  assert.deepEqual(rdpClientCapabilities(probe), capabilities);
  for (const changed of [{ platform: 'windows' }, { executable: '/usr/bin/xfreerdp3' }, { executableSha256: 'unknown' },
    { native: undefined }, { native: { ...probe.native, protocol: 'stock' } },
    { native: { ...probe.native, upstreamCommit: 'a'.repeat(40) } },
    { native: { ...probe.native, patchDigest: 'c'.repeat(64) } }, { native: { ...probe.native, extra: true } }]) {
    assert.equal(rdpClientCapabilities({ ...probe, ...changed }).available, false);
  }
  assert.equal(rdpClientCapabilities({ platform: 'linux', executable: '/usr/bin/xfreerdp3',
    version: 'FreeRDP version 3.32.1', help: '/from-stdin /cert:ignore /sec:nla /log-level:OFF /size: /clipboard' }).available, false);
});

test('RDP normal close preserves the input channel until native detach acknowledgement', async () => {
  const f = fixture(); const desktop = await f.adapter.open();
  let acknowledged = false;
  f.display.close = async () => {
    assert.equal(f.seen.session.signal.aborted, false);
    await Promise.resolve();
    assert.equal(f.seen.session.signal.aborted, false);
    acknowledged = true;
    return { sessionState: 'terminated', nativeInputState: 'detached', nativeReleaseSent: true };
  };
  const receipt = await desktop.close();
  assert.equal(acknowledged, true); assert.equal(f.seen.session.signal.aborted, true);
  assert.equal(receipt.nativeInputState, 'detached'); assert.equal(receipt.nativeReleaseSent, true);
});

test('RDP private bootstrap rejects controls, oversized native input, malformed UTF16, and clears its buffer', async () => {
  let held, copied;
  await writeRdpCredentialBootstrap(new Writable({ write(bytes, _encoding, callback) { held = bytes; copied = Buffer.from(bytes); callback(); } }), credentials);
  assert.deepEqual(JSON.parse(copied), credentials); assert.equal(held.every(byte => byte === 0), true);
  for (const password of ['bad\nextra', 'bad\rinput', 'bad\0input', '\ud800', 'a'.repeat(511)]) {
    let written = false;
    await assert.rejects(writeRdpCredentialBootstrap({ write() { written = true; } }, { ...credentials, password }), { code: 'DESKTOP_RDP_CREDENTIAL_UNAVAILABLE' });
    assert.equal(written, false);
  }
});

test('RDP private bootstrap aborts a stalled pipe and removes raw provider errors', async () => {
  const controller = new AbortController(), started = deferred();
  const pending = writeRdpCredentialBootstrap({ write() { started.resolve(); } }, credentials, controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(pending, { code: 'DESKTOP_RDP_CREDENTIAL_UNAVAILABLE' });
  const f = fixture({ credentialProvider: async () => { throw new Error(credentials.password); } });
  await assert.rejects(f.adapter.open(), error => error.code === 'DESKTOP_RDP_CREDENTIAL_UNAVAILABLE' && !String(error).includes(credentials.password));
  assert.equal(f.seen.tunnelClosed, 1);
});

test('RDP relay closes a late tunnel after cancellation without opening a display', async () => {
  const tunnel = deferred(), entered = deferred(), controller = new AbortController(); let closed = 0;
  const f = fixture({ openTunnel: async () => { entered.resolve(); return tunnel.promise; } });
  const pending = f.adapter.open({ signal: controller.signal });
  await entered.promise; controller.abort();
  tunnel.resolve({ host: '127.0.0.1', port: 33001, close: async () => { closed++; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(closed, 1); assert.equal(f.seen.session, undefined); assert.equal(f.seen.credentials, 0);
});

test('RDP relay closes a late managed display after cancellation and reports cleanup failures', async () => {
  const opening = deferred(), entered = deferred(), controller = new AbortController(); let displayClosed = 0;
  const f = fixture({ openSession: async () => { entered.resolve(); return opening.promise; } });
  const pending = f.adapter.open({ signal: controller.signal });
  await entered.promise; controller.abort();
  opening.resolve({ close: async () => { displayClosed++; } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(displayClosed, 1); assert.equal(f.seen.tunnelClosed, 1);
  const broken = fixture(); broken.display.close = async () => { throw new Error('private native error'); };
  const desktop = await broken.adapter.open(); const receipt = await desktop.close();
  assert.equal(receipt.outerSessionState, 'unknown'); assert.equal(receipt.cleanupError, 'DESKTOP_RDP_DISPLAY_CLEANUP_FAILED');
  assert.equal(broken.seen.tunnelClosed, 1);
});
