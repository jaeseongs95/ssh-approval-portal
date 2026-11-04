import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopState, transportDesktopState } from '../src/domain/desktop-state.mjs';
import { windowsDesktopState, createWindowsDesktopStateReader } from '../src/adapters/desktop/windows-state.mjs';
import { publicOutputSchemas } from '../src/adapters/mcp/public-contract.mjs';

const snapshot = (locked = true) => ({ version: 1, boot: '133900000000000000', consoleSessionId: 1,
  sessions: [{ id: 1, state: 1, locked }, { id: 2, state: 4, locked: true }] });

test('GUI-STATE handshake and WTS metadata never attest a desktop or a disconnected session', () => {
  assert.equal(transportDesktopState(100).state, 'transport_ready');
  const locked = windowsDesktopState(snapshot(), 100);
  assert.equal(locked.state, 'auth_required'); assert.equal(locked.osSessionId, 1); assert.equal(locked.locked, true);
  assert.equal(locked.ownerOnly, false); assert.equal(locked.inputAllowed, true);
  assert.deepEqual(locked.blockers, ['DESKTOP_AUTH_REQUIRED', 'DESKTOP_SESSION_BINDING_UNVERIFIED']);
  const unlocked = windowsDesktopState(snapshot(false), 101);
  assert.equal(unlocked.state, 'transport_ready'); assert.equal(unlocked.sessionBindingVerified, false);
  assert.equal(unlocked.displayBindingVerified, false); assert.equal(unlocked.inputAllowed, true);
  assert.throws(() => desktopState({ ...unlocked, state: 'desktop_ready' }), error => error.code === 'DESKTOP_INVALID_STATE');
  const noConsole = windowsDesktopState({ ...snapshot(false), consoleSessionId: 0xffff_ffff }, 102);
  assert.equal(noConsole.osSessionId, null); assert.equal(noConsole.locked, null); assert.equal(noConsole.inputAllowed, true);
  const unlockedRdp = windowsDesktopState({ ...snapshot(), sessions: [{ id: 1, state: 1, locked: true }, { id: 2, state: 0, locked: false }] }, 103);
  assert.equal(unlockedRdp.state, 'transport_ready'); assert.equal(unlockedRdp.inputAllowed, true);
});

test('GUI-STATE generations change on boot, lock or session changes and ignore row ordering and time', () => {
  const before = windowsDesktopState(snapshot(), 100);
  assert.equal(before.generation, windowsDesktopState({ ...snapshot(), sessions: snapshot().sessions.reverse() }, 200).generation);
  for (const value of [snapshot(false), { ...snapshot(), boot: '133900000000000001' }, { ...snapshot(), consoleSessionId: 2 }]) {
    assert.notEqual(before.generation, windowsDesktopState(value, 100).generation);
  }
  for (const value of [null, { ...snapshot(), sessions: [{ id: 1, state: 1, locked: 'false' }] },
    { ...snapshot(), sessions: [...snapshot().sessions, snapshot().sessions[0]] }]) {
    const result = windowsDesktopState(value, 100);
    assert.equal(result.state, 'transport_ready'); assert.equal(result.inputAllowed, true);
  }
});

test('GUI-STATE fixed native query consumes bounded stdin on the selected read profile and hides failures', async () => {
  let observed;
  const state = await createWindowsDesktopStateReader({ now: () => 100, executeCommand: async (...args) => {
    observed = args;
    return { failed: false, execution: { exitCode: 0, stdout: { truncated: false } }, data: { stdout: JSON.stringify(snapshot()) } };
  } })({ profile: 'windows-read', beforeDispatch: () => {} });
  assert.equal(state.state, 'auth_required'); assert.equal(observed[0], 'windows-read');
  assert.match(observed[1], /^powershell.exe .* -EncodedCommand /); assert.ok(observed[1].length <= 8000);
  assert.match(observed[3].stdin, /WTSQuerySessionInformationW/); assert.equal(observed[3].timeoutMs, 15000);
  assert.doesNotMatch(observed[3].stdin, /WTSConnectSession|LogonUser|SendSAS|Set-ItemProperty|password/i);
  const unavailable = await createWindowsDesktopStateReader({ now: () => 100, executeCommand: async () => { throw Error('PRIVATE_DETAIL'); } })({ profile: 'windows-read' });
  assert.deepEqual(unavailable.blockers, ['DESKTOP_SESSION_QUERY_FAILED']); assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_DETAIL/);
  const malformed = await createWindowsDesktopStateReader({ now: () => 100, executeCommand: async () => ({ failed: false,
    execution: { exitCode: 0 }, data: { stdout: '{PRIVATE_INVALID_JSON' } }) })({ profile: 'windows-read' });
  assert.equal(malformed.state, 'transport_ready'); assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE_INVALID_JSON/);
});

test('GUI-STATE public desktop status carries typed readiness and no screen pixels', () => {
  const data = { sessionId: '20000000-0000-4000-8000-000000000001', epoch: 1, targetId: 'windows', targetRevision: 'a'.repeat(64),
    expiresAt: 200, idleExpiresAt: 150, kind: 'desktop', readiness: windowsDesktopState(snapshot(), 100) };
  const schema = publicOutputSchemas['desktop-status'];
  assert.equal(typeof schema?.safeParse, 'function');
  // Use the same published response envelope; a status never returns an image or credentials.
  const reply = schema.safeParse({ contractVersion: '1.8', ok: true, data, error: null });
  assert.equal(reply.success, true, reply.error?.message);
  assert.doesNotMatch(JSON.stringify(reply.data), /image\/png|password|credential/i);
});
