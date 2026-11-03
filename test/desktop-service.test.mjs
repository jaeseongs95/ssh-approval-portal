import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopService } from '../src/application/desktop.mjs';

const binding = { ownerId: 'owner-a', targetId: 'linux', targetRevision: 'a'.repeat(64), epoch: 1 };
function fixture(options = {}) {
  const calls = [], state = { geometry: 1, valid: true, time: 1000 };
  const desktop = { closed: false, async observe() { return { width: 4, height: 3, geometryRevision: state.geometry, data: Buffer.from('test-image') }; },
    async input(actions) { calls.push(['input', actions]); }, release() { calls.push(['release']); return { sent: true }; }, close() { this.closed = true; calls.push(['close']); } };
  const service = createDesktopService({ adapter: { async open() { return desktop; } }, authorize: () => true, verifyTarget: () => state.valid,
    now: () => state.time, ...options });
  return { service, state, calls, desktop };
}
const error = code => value => value.code === code;

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
  await assert.rejects(service.open({ ...binding, ownerId: 'owner-b' }), error('DESKTOP_CAPACITY'));
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
  await service.open(binding); const other = await service.open({ ...binding, ownerId: 'owner-b' });
  const receipts = await service.closeOwner(binding.ownerId); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'fulfilled');
  assert.equal(service.size(), 1);
  await service.close({ ownerId: 'owner-b', sessionId: other.sessionId, epoch: 1 }); assert.equal(service.size(), 0);
});
