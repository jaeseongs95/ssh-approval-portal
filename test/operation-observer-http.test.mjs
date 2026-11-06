import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolAdapters } from '../src/adapters/http/protocol.mjs';
import { authorizeAdminRequest } from '../src/adapters/security/admin-policy.mjs';

// engineering-test-plan HK: public HTTP protocol/authentication/admission with real sockets.
// Operation service is injected: journal/SSH and actual host hooks are excluded here.
// Preconditions: existing owner credential; operation already exists; no mutation ports.
// HK01 stable key/ID read and bounded status; HK02 malformed selector/method/auth refusal;
// HK03 detached budget and control availability; HK04 reauthorize before status disclosure.
// Pass criteria: exact selector to observe, zero mutation ports, expected status/data only.
// Actual: NOT_RUN locally. TEST Node24: node --test test/operation-observer-http.test.mjs.
const key = 'http-observe-stable-key-0001', id = 'a'.repeat(48), revision = 'b'.repeat(64);
const job = () => ({ id, operationKey: key, kind: 'command', state: 'pending', targetId: 'alpha', targetRevision: revision,
  operation: {}, createdAt: 1, expiresAt: 9999999999999 });

async function fixture(t, { observe, authorize = authorizeAdminRequest } = {}) {
  const calls = [], shutdown = new AbortController();
  const mutation = () => assert.fail('observation must never mutate or execute');
  const servers = createProtocolAdapters({
    queue: { get: mutation, approve: mutation, deny: mutation, start: mutation, submit: mutation },
    commands: {}, files: {}, store: {}, signer: {}, lifecycle: { snapshot: () => ({}) },
    settings: { adminOrigin: 'https://owner.example.test', adminToken: 'synthetic-owner', mcpToken: 'synthetic-mcp' },
    adminAccess: { mode: 'token' }, authorizeAdminRequest: authorize, uiHtml: '<html></html>',
    shutdownSignal: shutdown.signal, requestAdmission: { admin: { maxActive: 1, maxQueued: 1, maxDetached: 1 } },
    operations: { async observe(selector, options) { calls.push(selector); return observe ? observe(selector, options) : { job: job(), waitTimedOut: true }; }, submit: mutation, cancel: mutation },
  });
  t.after(async () => {
    shutdown.abort(); servers.adminHttp.closeAllConnections();
    await new Promise(resolve => servers.adminHttp.close(resolve));
  });
  await new Promise(resolve => servers.adminHttp.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + servers.adminHttp.address().port;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000), ...options,
      headers: { Authorization: 'Bearer synthetic-owner', ...options.headers } });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls };
}

test('HK01 owner reads existing key and ID through the same bounded operation contract', async t => {
  const f = await fixture(t);
  for (const path of ['/api/operations/by-key?operationKey=' + key + '&waitMs=0', '/api/' + id + '?observe=1&waitMs=0']) {
    const response = await f.request(path);
    assert.equal(response.status, 200); assert.equal(response.body.ok, true);
    assert.equal(response.body.data.id, id); assert.equal(response.body.data.operationKey, key);
    assert.equal(response.body.data.targetId, 'alpha'); assert.equal(response.body.data.targetRevision, revision);
    assert.equal(response.body.data.outputPage, null); assert.equal(response.body.data.state, 'pending');
  }
  assert.deepEqual(f.calls, [{ operationKey: key, waitMs: 0 }, { id, waitMs: 0 }]);
});

test('HK02 malformed duplicate unknown selectors and unauthenticated calls cannot observe', async t => {
  const f = await fixture(t);
  for (const query of ['', '?operationKey=short', '?operationKey=' + key + '%0A', '?operationKey=' + key + '&operationKey=' + key,
    '?operationKey=' + key + '&waitMs=60001', '?operationKey=' + key + '&waitMs=0&waitMs=1', '?operationKey=' + key + '&id=' + id]) {
    const response = await f.request('/api/operations/by-key' + query);
    assert.equal(response.status, 400); assert.equal(response.body.error, 'INVALID_OPERATION_OBSERVER');
  }
  assert.equal((await f.request('/api/operations/by-key?operationKey=' + key, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.request('/api/operations/by-key?operationKey=' + key, { method: 'POST', headers: { Origin: 'https://owner.example.test' } })).status, 405);
  assert.deepEqual(f.calls, []);
});

test('HK03 key longpoll uses the existing detached budget while owner control stays available', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const f = await fixture(t, { observe: async () => { entered.resolve(); await release.promise; return { job: job(), waitTimedOut: true }; } });
  const pending = f.request('/api/operations/by-key?operationKey=' + key + '&waitMs=25000');
  try {
    await entered.promise;
    const overflow = await f.request('/api/operations/by-key?operationKey=' + key + '&waitMs=25000');
    assert.equal(overflow.status, 503); assert.equal(overflow.body.error, 'REQUEST_WAIT_LIMIT');
    assert.equal((await f.request('/api/session')).status, 200); assert.equal(f.calls.length, 1);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
});

test('HK04 key status is withheld if owner authority expires during observation', async t => {
  let expired = false;
  const f = await fixture(t, {
    authorize: (req, options) => expired ? { allowed: false, status: 401 } : authorizeAdminRequest(req, options),
    observe: async () => { expired = true; return { job: job(), waitTimedOut: false }; },
  });
  const response = await f.request('/api/operations/by-key?operationKey=' + key + '&waitMs=25000');
  assert.deepEqual(response, { status: 401, body: { error: 'OWNER_REAUTH_REQUIRED' } }); assert.equal(f.calls.length, 1);
});

test('HK05 missing or revision-conflicting keys preserve refusal without replacement work', async t => {
  for (const [code, status] of [['OPERATION_NOT_FOUND', 404], ['TARGET_REVISION_CONFLICT', 409]]) {
    const f = await fixture(t, { observe: async () => { throw Object.assign(Error('private'), { code }); } });
    assert.deepEqual(await f.request('/api/operations/by-key?operationKey=' + key), { status, body: { error: code } });
    assert.deepEqual(f.calls, [{ operationKey: key, waitMs: 0 }]);
  }
});
