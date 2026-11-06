import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../scripts/portal-files.mjs';

const id = 'a'.repeat(48), origin = 'https://owner.example.test';
const args = ['--origin', origin, '--cloudflared', process.execPath, 'watch', id];
const event = { event: 'operation.finished', id, state: 'completed', failed: false, auditFailure: false };
const capture = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };

test('watch CLI accepts an already completed operation without creating an upload', async () => {
  const out = capture(), err = capture();
  const code = await main(args, out, err, () => 'synthetic.header.signature', {}, () => assert.fail('not an upload'), undefined,
    () => ({ async connect() {}, async watch() { return event; }, async close() {} }));
  assert.equal(code, 0); assert.deepEqual(JSON.parse(out.text), event);
});

test('watch CLI waits outside model input and emits one final event; old upload client is not used', { timeout: 5000 }, async () => {
  const out = capture(), err = capture(), entered = Promise.withResolvers(), done = Promise.withResolvers();
  let connected = false, closed = 0, observed;
  const pending = main(args, out, err, () => 'synthetic.header.signature', {}, () => assert.fail('not an upload'), undefined,
    options => { observed = options; return {
      async connect() { connected = true; },
      async watch(requestId) { assert.equal(requestId, id); entered.resolve(); await done.promise; return event; },
      async close() { closed++; },
    }; });
  try {
    await entered.promise;
    assert.equal(connected, true); assert.equal(out.text, '');
    assert.equal(await Promise.resolve('independent work'), 'independent work');
    done.resolve(); assert.equal(await pending, 0);
    assert.deepEqual(JSON.parse(out.text), event); assert.equal(out.text.trim().split('\n').length, 1);
    assert.equal(JSON.parse(err.text).event, 'operation.watch.started');
    assert.equal(observed.origin, origin); assert.equal(observed.timeoutMs, 600000); assert.equal(closed, 1);
  } finally { done.resolve(); }
});

test('watch CLI preserves failed and uncertain terminal states with exit 1 and no replay', async () => {
  for (const state of ['failed', 'denied', 'cancelled', 'expired', 'unknown']) {
    const out = capture(), err = capture(); let closed = 0, reads = 0;
    const code = await main(args, out, err, () => 'synthetic.header.signature', {}, undefined, undefined,
      () => ({ async connect() {}, async watch() { reads++; return { ...event, state, failed: true }; }, async close() { closed++; } }));
    assert.equal(code, 1); assert.equal(JSON.parse(out.text).state, state); assert.equal(reads, 1); assert.equal(closed, 1);
  }
});

test('watch CLI rejects malformed identifiers and deadlines before credentials or owner connection', async () => {
  for (const argv of [args.slice(0, -1).concat(id + '\n'), args.concat('--timeout-ms', '600001'), args.concat('--timeout-ms', '100\n')]) {
    const out = capture(), err = capture();
    const code = await main(argv, out, err, () => assert.fail('credential must not be read'), {}, undefined, undefined,
      () => assert.fail('no owner connection'));
    assert.equal(code, 1); assert.equal(out.text, ''); assert.match(JSON.parse(err.text).error, /^INVALID_/);
  }
});

test('watch CLI read failure retains the original ID and closes its session', async () => {
  const out = capture(), err = capture(); let closed = 0;
  const code = await main(args, out, err, () => 'synthetic.header.signature', {}, undefined, undefined,
    () => ({ async connect() {}, async watch() { throw Object.assign(Error('private not printed'), { code: 'OWNER_REAUTH_REQUIRED' }); }, async close() { closed++; } }));
  assert.equal(code, 1); assert.equal(out.text, ''); assert.equal(closed, 1);
  const refusal = JSON.parse(err.text.trim().split('\n').at(-1));
  assert.deepEqual(refusal, { error: 'OWNER_REAUTH_REQUIRED', requestId: id }); assert.doesNotMatch(err.text, /private not printed|synthetic/);
});

test('opt-in completion notification runs once after terminal status and keeps failures separate from SSH', async () => {
  for (const notificationFails of [false, true]) {
    const out = capture(), err = capture(); let terminal = false, notifications = 0;
    const argv = [...args, '--notify-codex', process.execPath, '--thread', '12345678-1234-4234-8234-123456789abc'];
    const code = await main(argv, out, err, () => 'synthetic.header.signature', {}, undefined, undefined,
      () => ({ async connect() {}, async watch() { terminal = true; return event; }, async close() {} }),
      async options => {
        notifications++; assert.equal(terminal, true); assert.deepEqual(options.event, event);
        if (notificationFails) throw Error('private notifier output');
        return { state: 'queued', messageId: '12345678-1234-4234-8234-123456789abc', resumption: 'requested' };
      });
    assert.equal(notifications, 1); assert.equal(code, notificationFails ? 1 : 0);
    const value = JSON.parse(out.text); assert.equal(value.state, 'completed');
    assert.equal(value.notification.state, notificationFails ? 'unknown' : 'queued');
    assert.doesNotMatch(err.text, /private notifier output/);
    if (notificationFails) assert.match(err.text, /COMPLETION_NOTIFICATION_FAILED/);
  }
});

test('completion routing requires an explicit executable and exact thread before authentication', async () => {
  for (const extra of [['--thread', '12345678-1234-4234-8234-123456789abc'], ['--notify-codex', process.execPath],
    ['--notify-codex', process.execPath, '--thread', 'wrong-thread']]) {
    const out = capture(), err = capture();
    assert.equal(await main([...args, ...extra], out, err, () => assert.fail('no credential access')), 1);
    assert.equal(out.text, ''); assert.match(err.text, /INVALID_(?:CODEX_)?COMPLETION_TARGET/);
  }
});

// engineering-test-plan CK: CLI public argv boundary; watcher injected, owner/SSH excluded.
// Input/procedure: key with binding, key+ID conflict, malformed key/binding, read refusal.
// Pass: exact selector and 600000ms default; rejection precedes credentials; fixed ID/key errors.
// Actual: NOT_RUN locally; TEST Node24 node --test test/operation-watch-cli.test.mjs.
const key = 'cli-watch-stable-key-0001', revision = 'b'.repeat(64);
const keyArgs = [...args.slice(0, -1), '--operation-key', key];
test('CK01 key watch passes exact selector binding and retains the existing deadline', async () => {
  const out = capture(), err = capture(); let observedOptions, observedSelector;
  assert.equal(await main([...keyArgs, '--target', 'alpha', '--expected-target-revision', revision], out, err,
    () => 'synthetic.header.signature', {}, () => assert.fail('no upload'), undefined, options => {
      observedOptions = options; return { async connect() {}, async watch(selector) { observedSelector = selector; return { ...event, operationKey: key }; }, async close() {} };
    }), 0);
  assert.deepEqual(observedSelector, { operationKey: key, target: 'alpha', expectedTargetRevision: revision });
  assert.equal(observedOptions.timeoutMs, 600000);
  assert.deepEqual(JSON.parse(err.text), { event: 'operation.watch.started', operationKey: key, timeoutMs: 600000 });
  assert.equal(JSON.parse(out.text).id, id);
});

test('CK02 key and ID are exclusive and malformed selectors refuse before authentication', async () => {
  for (const argv of [[...keyArgs, id], [...keyArgs.slice(0, -1), 'short'], [...keyArgs.slice(0, -1), key + '\n'],
    [...keyArgs, '--target', 'alpha'], [...keyArgs, '--expected-target-revision', revision],
    [...keyArgs, '--target', 'Alpha', '--expected-target-revision', revision],
    [...keyArgs, '--target', 'alpha', '--expected-target-revision', revision + '\n']]) {
    const out = capture(), err = capture();
    assert.equal(await main(argv, out, err, () => assert.fail('no credentials'), {}, undefined, undefined,
      () => assert.fail('no connection')), 1);
    assert.equal(out.text, ''); assert.match(JSON.parse(err.text).error, /^INVALID_/);
  }
});

test('CK03 key observation errors retain the key and learned ID without replay', async () => {
  const out = capture(), err = capture(); let closed = 0;
  assert.equal(await main(keyArgs, out, err, () => 'synthetic.header.signature', {}, undefined, undefined,
    () => ({ async connect() {}, async watch() { throw Object.assign(Error('private'), { code: 'OPERATION_BINDING_CONFLICT', requestId: id }); }, async close() { closed++; } })), 1);
  assert.deepEqual(JSON.parse(err.text.trim().split('\n').at(-1)), { error: 'OPERATION_BINDING_CONFLICT', requestId: id, operationKey: key });
  assert.equal(out.text, ''); assert.equal(closed, 1);
});

test('CK04 ID observation also accepts the exact expected target binding', async () => {
  const out = capture(), err = capture(); let observed;
  assert.equal(await main([...args, '--target', 'alpha', '--expected-target-revision', revision], out, err,
    () => 'synthetic.header.signature', {}, undefined, undefined,
    () => ({ async connect() {}, async watch(selector) { observed = selector; return event; }, async close() {} })), 0);
  assert.deepEqual(observed, { id, target: 'alpha', expectedTargetRevision: revision });
});
