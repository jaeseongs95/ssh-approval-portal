import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopService } from '../src/application/desktop.mjs';
import { windowsDesktopState } from '../src/adapters/desktop/windows-state.mjs';
import { desktopState } from '../src/domain/desktop-state.mjs';

const binding = { ownerId: 'owner-a', targetId: 'linux', targetRevision: 'a'.repeat(64), epoch: 1 };
function fixture(options = {}) {
  const calls = [], state = { geometry: 1, valid: true, authorized: true, time: 1000 };
  const desktop = { closed: false, async observe() { return { width: 4, height: 3, geometryRevision: state.geometry, data: Buffer.from('test-image') }; },
    async input(actions) { calls.push(['input', actions]); }, release() { calls.push(['release']); return { sent: true }; }, close() { this.closed = true; calls.push(['close']); } };
  const service = createDesktopService({ adapter: { async open() { return desktop; } }, authorize: () => state.authorized, verifyTarget: () => state.valid,
    now: () => state.time, ...options });
  return { service, state, calls, desktop };
}
const error = code => value => value.code === code;

test('GUI-AUTH login screens remain observable; owner private input and SAS never become model tools or replayable credentials', async () => {
  const locked = windowsDesktopState({ version: 1, boot: '133900000000000000', consoleSessionId: 1,
    sessions: [{ id: 1, state: 1, locked: true }, { id: 2, state: 4, locked: true }] }, 1000);
  for (const owner of [true, false]) {
    const f = fixture({ readState: () => locked, canViewProtected: () => owner });
    const lease = await f.service.open(binding), identity = { ownerId: binding.ownerId, sessionId: lease.sessionId, epoch: binding.epoch };
    assert.equal((await f.service.status(identity)).readiness.state, 'auth_required');
    const frame = await f.service.observe(identity);
    assert.equal(frame.data, Buffer.from('test-image').toString('base64'));
    const args = { ...identity, frameId: frame.frameId, geometryRevision: frame.geometryRevision,
      sequence: 1, requestKey: 'owner-private', confirmed: true, action: 'credential', value: 'SYNTHETIC-ONE-TIME' };
    if (owner) {
      const receipt = await f.service.authenticate(args);
      assert.equal(args.value, undefined); assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC|credential/);
      assert.equal(f.calls.filter(call => call[0] === 'input').length, 1);
      await assert.rejects(f.service.authenticate({ ...args, value: 'different' }), error('DESKTOP_INPUT_SEQUENCE'));
      const fresh = await f.service.observe(identity);
      await f.service.authenticate({ ...identity, frameId: fresh.frameId, geometryRevision: fresh.geometryRevision,
        sequence: 2, requestKey: 'owner-sas', confirmed: true, action: 'sas' });
      assert.deepEqual(f.calls.filter(call => call[0] === 'input')[1][1].map(action => [action.keysym, action.down]),
        [[0xffe3,true],[0xffe9,true],[0xffff,true],[0xffff,false],[0xffe9,false],[0xffe3,false]]);
    } else {
      assert.throws(() => f.service.authenticate(args), error('DESKTOP_OWNER_AUTH_REQUIRED'));
      // Unknown capture/session binding must not break the pre-existing ordinary input path.
      await f.service.input({ ...args, actions: [{ type: 'key', keysym: 0xff1b, down: false }] });
    }
    await f.service.close(identity); assert.equal(f.service.size(), 0);
  }
});

test('GUI-AUTH changed backend generation fences same-size frames and a lock appearing before dispatch', async () => {
  let state = desktopState({ state: 'desktop_ready', observedAt: 1000, generation: 'a'.repeat(64), osSessionId: 2,
    locked: false, sessionBindingVerified: true, displayBindingVerified: true, inputVerified: true, inputAllowed: true, ownerOnly: false, blockers: [] });
  const f = fixture({ readState: () => state });
  const lease = await f.service.open(binding), identity = { ownerId: binding.ownerId, sessionId: lease.sessionId, epoch: binding.epoch };
  const frame = await f.service.observe(identity);
  state = desktopState({ ...state, generation: 'b'.repeat(64) });
  const args = { ...identity, frameId: frame.frameId, geometryRevision: frame.geometryRevision,
    sequence: 1, requestKey: 'generation', actions: [{ type: 'text', text: 'never-send' }] };
  await assert.rejects(f.service.input(args), error('DESKTOP_STALE_FRAME'));
  const fresh = await f.service.observe(identity), observe = f.desktop.observe;
  f.desktop.observe = async options => {
    const result = await observe(options);
    if (options?.includeImage === false) state = desktopState({ ...state, state: 'auth_required', locked: true,
      generation: 'c'.repeat(64), inputAllowed: false, ownerOnly: false, blockers: ['DESKTOP_AUTH_REQUIRED'] });
    return result;
  };
  await assert.rejects(f.service.input({ ...args, frameId: fresh.frameId }), error('DESKTOP_AUTH_REQUIRED'));
  assert.equal(f.calls.filter(item => item[0] === 'input').length, 0);
  assert.equal((await f.service.close(identity)).logout, false);
});

test('GUI lease fences owner, epoch, target revision and expires with key cleanup', async () => {
  const { service, state, calls } = fixture({ ttlMs: 100 });
  const opened = await service.open(binding), args = { ownerId: binding.ownerId, sessionId: opened.sessionId, epoch: 1 };
  assert.throws(() => service.observe({ ...args, ownerId: 'other' }), error('DESKTOP_NOT_FOUND'));
  assert.throws(() => service.observe({ ...args, epoch: 2 }), error('DESKTOP_STALE_LEASE'));
  state.time += 101;
  await assert.rejects(service.observe(args), error('DESKTOP_EXPIRED'));
  assert.deepEqual(calls.map(item => item[0]), ['release', 'close']); assert.equal(service.size(), 0);
  const denied = fixture({ authorize: () => false });
  await assert.rejects(denied.service.open(binding), error('DESKTOP_NOT_AUTHORIZED'));
});

test('GUI input accepts continuous frames, deduplicates latest receipt and refuses stale geometry', async t => {
  const { service, state, calls } = fixture(); t.after(() => service.closeAll());
  const opened = await service.open(binding), args = { ownerId: binding.ownerId, sessionId: opened.sessionId, epoch: 1 };
  const frame = await service.observe(args);
  const input = { ...args, frameId: frame.frameId, geometryRevision: 1, sequence: 1, requestKey: 'first', actions: [{ type: 'key', keysym: 65, down: true }] };
  await assert.rejects(service.input({ ...input, actions: [{ type: 'text', text: 'x'.repeat(2048) }, ...input.actions] }), error('DESKTOP_INVALID_INPUT'));
  await service.input(input);
  const second = { ...input, sequence: 2, requestKey: 'second', actions: [{ type: 'key', keysym: 65, down: false }] };
  const receipt = await service.input(second); assert.deepEqual(await service.input(second), receipt);
  assert.equal(calls.filter(item => item[0] === 'input').length, 2);
  await assert.rejects(service.input({ ...second, actions: [{ type: 'key', keysym: 66, down: false }] }), error('DESKTOP_INPUT_CONFLICT'));
  await assert.rejects(service.input({ ...second, sequence: 4 }), error('DESKTOP_INPUT_SEQUENCE'));
  state.geometry = 2;
  await assert.rejects(service.input({ ...input, sequence: 3, requestKey: 'third' }), error('DESKTOP_STALE_FRAME'));
  assert.equal(calls.filter(item => item[0] === 'input').length, 2);
  assert.equal((await service.observe(args)).geometryRevision, 2);
  state.valid = false;
  await assert.rejects(service.observe(args), error('DESKTOP_STALE_TARGET')); assert.equal(service.size(), 0);
});

test('GUI capacity includes pending opens and has a separate per-owner ceiling', async () => {
  let resolveOpen;
  const adapter = { open: () => new Promise(resolve => { resolveOpen = resolve; }) };
  const { service, desktop } = fixture({ adapter, maxSessions: 1 });
  const opening = service.open(binding);
  await assert.rejects(service.open({ ...binding, ownerId: 'owner-b', targetId: 'windows' }), error('DESKTOP_CAPACITY'));
  resolveOpen(desktop); await opening; await service.closeAll(); assert.equal(service.size(), 0);
});

test('an uncertain GUI input is never retried and closes its lease', async () => {
  const { service, desktop, calls } = fixture();
  desktop.input = async () => { calls.push(['input']); throw Object.assign(Error('transport lost'), { code: 'DESKTOP_TRANSPORT_CLOSED' }); };
  const opened = await service.open(binding), args = { ownerId: binding.ownerId, sessionId: opened.sessionId, epoch: 1 };
  const frame = await service.observe(args);
  await assert.rejects(service.input({ ...args, frameId: frame.frameId, geometryRevision: 1, sequence: 1, requestKey: 'uncertain', actions: [{ type: 'text', text: 'x' }] }), error('DESKTOP_TRANSPORT_CLOSED'));
  assert.equal(calls.filter(item => item[0] === 'input').length, 1); assert.equal(service.size(), 0);
});

test('logout closes only that owner including a lease whose open receipt was lost', async () => {
  const { service } = fixture({ maxSessions: 2, adapter: { async open() {
    return { closed: false, release: () => ({ sent: true }), close() { this.closed = true; } };
  } } });
  await service.open(binding); const other = await service.open({ ...binding, targetId: 'windows', ownerId: 'owner-b' });
  const receipts = await service.closeOwner(binding.ownerId); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'fulfilled');
  assert.equal(service.size(), 1);
  await service.close({ ownerId: 'owner-b', sessionId: other.sessionId, epoch: 1 }); assert.equal(service.size(), 0);
});

test('one physical desktop excludes different owners and target aliases while opening and disposing', { timeout: 2000 }, async () => {
  const firstOpen = Promise.withResolvers(), secondOpen = Promise.withResolvers(), release = Promise.withResolvers();
  let opens = 0;
  const { desktop } = fixture();
  desktop.release = () => release.promise;
  const { service } = fixture({ leaseKey: () => 'ssh-host:22:vnc:5900', adapter: { open: () => (++opens === 1 ? firstOpen : secondOpen).promise } });
  const opening = service.open(binding);
  await assert.rejects(service.open({ ...binding, ownerId: 'owner-b' }), error('DESKTOP_RESOURCE_BUSY'));
  await assert.rejects(service.open({ ...binding, targetId: 'alias', ownerId: 'owner-b' }), error('DESKTOP_RESOURCE_BUSY'));
  firstOpen.resolve(desktop); const lease = await opening;
  const closing = service.close({ ownerId: binding.ownerId, sessionId: lease.sessionId, epoch: binding.epoch });
  await Promise.resolve();
  await assert.rejects(service.open({ ...binding, targetId: 'alias', ownerId: 'owner-b' }), error('DESKTOP_RESOURCE_BUSY'));
  release.resolve({ sent: true }); await closing;
  assert.equal(service.size(), 0);
  const next = service.open({ ...binding, targetId: 'alias', ownerId: 'owner-b' });
  secondOpen.resolve({ release: () => ({ sent: true }), close() {} }); const nextLease = await next;
  assert.equal(opens, 2);
  await service.close({ ownerId: 'owner-b', sessionId: nextLease.sessionId, epoch: binding.epoch });
});

test('authority is rechecked before every observation and input after initial admission', async () => {
  for (const action of ['observe', 'input']) {
    const { service, state, calls } = fixture();
    const lease = await service.open(binding), identity = { ownerId: binding.ownerId, sessionId: lease.sessionId, epoch: binding.epoch };
    const frame = await service.observe(identity); state.authorized = false;
    const args = { ...identity, frameId: frame.frameId, geometryRevision: frame.geometryRevision,
      sequence: 1, requestKey: 'revoked', actions: [{ type: 'text', text: 'forbidden' }] };
    await assert.rejects(service[action](args), error('DESKTOP_NOT_AUTHORIZED'));
    assert.equal(calls.filter(item => item[0] === 'input').length, 0); assert.equal(service.size(), 0);
  }
});

test('asynchronous authority revocation while geometry is observed prevents input dispatch', async () => {
  let allowed = true, holdAuthorization = false, resolveAuthorization;
  const authorize = async () => holdAuthorization ? new Promise(resolve => { resolveAuthorization = resolve; }) : allowed;
  const { service, desktop, calls } = fixture({ authorize });
  const lease = await service.open(binding), identity = { ownerId: binding.ownerId, sessionId: lease.sessionId, epoch: binding.epoch };
  const frame = await service.observe(identity);
  const observe = desktop.observe;
  desktop.observe = async options => { const result = await observe(options); holdAuthorization = true; return result; };
  const input = service.input({ ...identity, frameId: frame.frameId, geometryRevision: frame.geometryRevision,
    sequence: 1, requestKey: 'async-revoked', actions: [{ type: 'text', text: 'forbidden' }] });
  while (!resolveAuthorization) await new Promise(resolve => setImmediate(resolve));
  allowed = false; resolveAuthorization(false);
  await assert.rejects(input, error('DESKTOP_NOT_AUTHORIZED'));
  assert.equal(calls.filter(item => item[0] === 'input').length, 0); assert.equal(service.size(), 0);
});

test('closing a pending open keeps the physical resource reserved until its late channel is closed', async () => {
  let resolveOpen;
  const { desktop } = fixture();
  const { service } = fixture({ leaseKey: () => 'same-endpoint', adapter: { open: () => new Promise(resolve => { resolveOpen = resolve; }) } });
  const opening = service.open(binding);
  while (!resolveOpen) await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(opening, error('DESKTOP_EXPIRED'));
  const closing = service.closeOwner(binding.ownerId);
  await assert.rejects(service.open({ ...binding, targetId: 'alias', ownerId: 'owner-b' }), error('DESKTOP_RESOURCE_BUSY'));
  resolveOpen(desktop); await rejected; await closing;
  assert.equal(desktop.closed, true); assert.equal(service.size(), 0);
});
