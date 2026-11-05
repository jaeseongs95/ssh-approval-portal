import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationWatcher } from '../src/adapters/cli/operation-watcher.mjs';

// Pre-execution cases: ../../CASES.ko.md. TEST/Actions only; never run locally.
// Real owner session/watcher, injected HTTP only. Host background resumption is separate.
const origin = 'https://owner.example.test', accessToken = 'synthetic.header.signature';
const id = 'a'.repeat(48), revision = 'b'.repeat(64), privateMarker = 'PRIVATE_RESPONSE_MUST_NOT_ESCAPE';
const cookie = '__Host-ssh_admin_session=' + 'f'.repeat(64);
const operation = (state = 'completed', patch = {}) => ({
  id, state, targetId: 'alpha', targetRevision: revision, finishedAt: 123,
  failed: false, auditFailure: false, failureCode: null, remoteOutcome: 'completed',
  execution: { exitCode: 0, reason: 'exit' }, output: { state: 'ready' }, ...patch,
});
const envelope = data => ({ contractVersion: '2.0', ok: true, data, error: null });
const response = data => Response.json(envelope(data));
const expected = (patch = {}) => ({ event: 'operation.finished', id, state: 'completed', targetId: 'alpha',
  targetRevision: revision, finishedAt: 123, failed: false, auditFailure: false, failureCode: null,
  exitCode: 0, reason: 'exit', remoteOutcome: 'completed', outputState: 'ready', ...patch });

function fixture(t, { pages = [operation()], read, signal, timeoutMs } = {}) {
  const calls = [];
  let index = 0;
  const fetch = async (url, init) => {
    const parsed = new URL(url), call = { path: parsed.pathname, query: parsed.search, method: init.method };
    calls.push(call);
    assert.equal(parsed.origin, origin); assert.equal(init.headers['cf-access-token'], accessToken);
    assert.equal(init.redirect, 'error');
    if (parsed.pathname === '/api/session') return Response.json({ mode: 'access' });
    if (parsed.pathname === '/api/session/start') return Response.json({ connected: true }, { headers: {
      'Set-Cookie': cookie + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600',
    } });
    assert.equal(init.headers.Cookie, cookie, 'reads and logout retain the owner session binding');
    if (parsed.pathname === '/api/session/logout') return Response.json({ connected: false });
    assert.equal(parsed.pathname, '/api/' + id);
    assert.equal(parsed.search, '?observe=1&waitMs=25000'); assert.equal(init.method, 'GET');
    if (read) return read({ index: index++, signal: init.signal });
    assert.ok(index < pages.length, 'watch must stop after its terminal response');
    return response(pages[index++]);
  };
  const watcher = createOperationWatcher({ origin, accessToken, fetch, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  t.after(() => watcher.close().catch(() => {}));
  return { watcher, calls };
}
const reads = f => f.calls.filter(call => call.path === '/api/' + id);
function noRemoteEffects(f) {
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET' && !['/api/session/start', '/api/session/logout'].includes(call.path)), []);
}
function typedFailure(error, code) {
  assert.equal(typeof error.code, 'string'); assert.match(error.code, /^[A-Z][A-Z0-9_]+$/);
  if (code) assert.equal(error.code, code);
  assert.equal(error.requestId, id);
  assert.equal((String(error) + JSON.stringify(error)).includes(privateMarker), false);
  assert.equal((String(error) + JSON.stringify(error)).includes(accessToken), false);
  return true;
}
function blocked(signal, entered) {
  entered.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('W01 W09 already completed work returns one bounded event without output or command disclosure', async t => {
  const f = fixture(t, { pages: [operation('completed', { command: privateMarker, internalPath: privateMarker,
    output: { state: 'ready', text: privateMarker, internalPath: privateMarker }, result: { texts: [privateMarker] },
    accessToken, unexpected: privateMarker })] });
  assert.deepEqual(await f.watcher.connect(), { connected: true, mode: 'access' });
  const event = await f.watcher.watch(id);
  assert.deepEqual(event, expected()); assert.equal(JSON.stringify(event).includes(privateMarker), false);
  assert.equal(JSON.stringify(event).includes(accessToken), false); assert.equal(reads(f).length, 1);
  await f.watcher.close();
  assert.equal(f.calls.filter(call => call.path === '/api/session/logout').length, 1); noRemoteEffects(f);
});

test('W02 pending longpoll permits independent work and resolves only once after completion', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = fixture(t, { read: async ({ index }) => {
    if (index === 0) return response(operation('pending', { finishedAt: null }));
    assert.equal(index, 1, 'no extra status read after terminal completion');
    entered.resolve(); await release.promise; return response(operation());
  } });
  t.after(() => release.resolve()); await f.watcher.connect();
  let settled = false;
  const waiting = f.watcher.watch(id).then(value => { settled = true; return value; });
  await entered.promise;
  assert.equal(await Promise.resolve('independent-command-finished'), 'independent-command-finished');
  assert.equal(settled, false, 'background wait must not block unrelated work or invent completion');
  release.resolve(); assert.deepEqual(await waiting, expected()); assert.equal(reads(f).length, 2); noRemoteEffects(f);
});

test('W03 failure refusal cancellation expiry and unknown remain distinct terminal results', async t => {
  for (const state of ['failed', 'denied', 'unknown', 'cancelled', 'expired']) await t.test(state, async t => {
    const remoteOutcome = state === 'unknown' ? 'unknown' : 'not_started';
    const f = fixture(t, { pages: [operation(state, { failed: true, auditFailure: true, failureCode: 'SYNTHETIC_FAILURE', remoteOutcome,
      execution: { exitCode: state === 'failed' ? 7 : null, reason: state === 'cancelled' ? 'cancel' : 'transport_lost' }, output: { state: 'unavailable' } })] });
    await f.watcher.connect();
    assert.deepEqual(await f.watcher.watch(id), expected({ state, failed: true, auditFailure: true, failureCode: 'SYNTHETIC_FAILURE',
      remoteOutcome, exitCode: state === 'failed' ? 7 : null, reason: state === 'cancelled' ? 'cancel' : 'transport_lost', outputState: 'unavailable' }));
    assert.equal(reads(f).length, 1); noRemoteEffects(f);
  });
});

test('W04 foreign IDs invalid states malformed contracts and refusals retain the requested ID', async t => {
  const variants = [
    ['foreign ID', envelope(operation('completed', { id: 'c'.repeat(48) }))],
    ['invalid state', envelope(operation('apparently_done'))],
    ['contract', { ...envelope(operation()), contractVersion: '1.0' }],
    ['missing data', { ...envelope(null), private: privateMarker }],
    ['refusal', { contractVersion: '2.0', ok: false, data: null, error: { code: 'TARGET_REVISION_CONFLICT', detail: privateMarker } }],
  ];
  for (const [name, payload] of variants) await t.test(name, async t => {
    const f = fixture(t, { read: () => Response.json(payload) }); await f.watcher.connect();
    await assert.rejects(f.watcher.watch(id), error => typedFailure(error));
    assert.equal(reads(f).length, 1); noRemoteEffects(f);
  });
});

test('W05 target or revision changes after the initial status cannot produce completion', async t => {
  for (const patch of [{ targetId: 'beta' }, { targetRevision: 'c'.repeat(64) }]) await t.test(Object.keys(patch)[0], async t => {
    const f = fixture(t, { pages: [operation('pending', { finishedAt: null }), operation('completed', patch)] });
    await f.watcher.connect(); await assert.rejects(f.watcher.watch(id), error => typedFailure(error));
    assert.equal(reads(f).length, 2); noRemoteEffects(f);
  });
});

test('W06 HTTP authentication refusal and transport failures preserve typed errors without retry', async t => {
  for (const [status, code] of [[401, 'OWNER_REAUTH_REQUIRED'], [409, 'PORTAL_REQUEST_REFUSED'], [0, 'PORTAL_READ_FAILED']]) await t.test(String(status), async t => {
    const f = fixture(t, { read: () => {
      if (!status) throw Error(privateMarker + ' ' + accessToken);
      return Response.json({ error: privateMarker }, { status });
    } });
    await f.watcher.connect(); await assert.rejects(f.watcher.watch(id), error => typedFailure(error, code));
    assert.equal(reads(f).length, 1); noRemoteEffects(f);
  });
});

test('W07 close interrupts only the local read and logs out without cancelling remote work', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), f = fixture(t, { read: ({ signal }) => blocked(signal, entered) });
  await f.watcher.connect();
  const waiting = assert.rejects(f.watcher.watch(id), error => typedFailure(error));
  await entered.promise; await f.watcher.close(); await waiting;
  assert.equal(f.calls.filter(call => call.path === '/api/session/logout').length, 1); noRemoteEffects(f);
  await assert.rejects(f.watcher.watch(id)); assert.equal(reads(f).length, 1);
});

test('W08 external abort stops observation and preserves identity without remote cancellation', { timeout: 5000 }, async t => {
  const controller = new AbortController(), entered = Promise.withResolvers();
  const f = fixture(t, { signal: controller.signal, read: ({ signal }) => blocked(signal, entered) });
  await f.watcher.connect();
  const waiting = assert.rejects(f.watcher.watch(id), error => typedFailure(error));
  await entered.promise; controller.abort(); await waiting;
  assert.equal(reads(f).length, 1); noRemoteEffects(f);
});

test('W10 invalid operation identifiers are rejected before any operation read', async t => {
  const f = fixture(t); await f.watcher.connect();
  for (const invalid of ['bad', '../api/requests', id + '\n', 'A'.repeat(48)]) {
    await assert.rejects(f.watcher.watch(invalid), error => {
      assert.equal(typeof error.code, 'string'); return true;
    });
  }
  assert.equal(reads(f).length, 0); noRemoteEffects(f);
});
