import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';

// engineering-test-plan: HTTP integration; real sockets and SDK, injected SSH only.
// INV-BOUND/FIFO-DEADLINE: incomplete bodies hold admission before SDK parsing;
// independent oracles are configured limits, submission order, and zero effects.
// INV-CONTROL/AUTHORITY: saturated waits/approvals preserve control and authorization.
// INV-SETTLE: disconnect and shutdown remove unstarted work without SSH replay.
// Run in approved CI/server only: node --test test/http-admission.test.mjs.
// Local product execution and mutation proof are NOT_RUN by assignment.
const origin = 'https://owner.example.test';
const limits = { maxActive: 1, maxQueued: 2, maxWaitMs: 5000, maxDetached: 1 };

async function eventually(predicate, message = 'HTTP admission condition did not become true') {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

async function fixture(t, { mcp = {}, admin = {}, executeCommand } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'http-admission-'));
  const sockets = new Set(), releases = new Set(), calls = [];
  const app = await createApplication({
    registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }),
    executeCommand: async (...args) => {
      calls.push(args[1]);
      return executeCommand ? executeCommand(...args) : { failed: false, texts: [] };
    },
    audit: () => {}, transferRoot: root, uiHtml: '<html></html>',
    requestAdmission: { mcp: { ...limits, ...mcp }, admin: { ...limits, ...admin } },
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_ADMIN_ORIGIN: origin },
  });
  let client;
  t.after(async () => {
    for (const release of releases) release();
    for (const socket of sockets) socket.destroy();
    await client?.close();
    await app.close();
    assert.ok(root.startsWith(join(tmpdir(), 'http-admission-')));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([app.mcpHttp, app.adminHttp].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const mcpBase = 'http://127.0.0.1:' + app.mcpHttp.address().port;
  const adminBase = 'http://127.0.0.1:' + app.adminHttp.address().port;
  client = new Client({ name: 'http-admission-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpBase + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
  let rpcId = 1000;

  function raw(base, path, body, { hold = false, headers = {}, method = 'POST' } = {}) {
    let req;
    const response = new Promise((resolve, reject) => {
      req = request(new URL(path, base), { method, agent: false, headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      sockets.add(req);
      req.on('close', () => sockets.delete(req));
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(Error('fixture HTTP request timed out')));
      if (hold) req.write(body.slice(0, 1));
      else req.end(body);
    });
    // A deliberately disconnected socket can reject before its assertion attaches.
    response.catch(() => {});
    return { req, response, finish: () => req.end(body.slice(1)) };
  }
  const f = {
    app, client, calls, releases, queue: app.targets.select('default').queue,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    rawCall(name, args = {}, options = {}) {
      return raw(mcpBase, '/mcp', JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }), {
        ...options, headers: { Authorization: 'Bearer fixture-mcp', Accept: 'application/json, text/event-stream', ...options.headers },
      });
    },
    rawBody(body, contentType = 'application/json') {
      return raw(mcpBase, '/mcp', body, {
        headers: { Authorization: 'Bearer fixture-mcp', Accept: 'application/json, text/event-stream', 'Content-Type': contentType },
      });
    },
    rawBatch: (messages, contentType) => f.rawBody(JSON.stringify(messages), contentType),
    slowAdmin: () => raw(adminBase, '/api/environment', '{}', { hold: true, headers: { Authorization: 'Bearer fixture-owner', Origin: origin } }),
    owner: (path, { method = 'GET', headers = {}, signal } = {}) => fetch(adminBase + path, {
      method, headers: { Authorization: 'Bearer fixture-owner', ...(method === 'POST' ? { Origin: origin } : {}), ...headers }, signal: signal ?? AbortSignal.timeout(2000),
    }),
    async health() {
      const response = await fetch(mcpBase + '/health', { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
  f.snapshot = async () => (await f.health()).requestAdmission;
  await eventually(async () => (await f.snapshot()).mcp.active === 0);
  const initial = await f.snapshot();
  assert.deepEqual(initial.mcp, { active: 0, queued: 0, detached: 0, closed: false, ...limits, ...mcp });
  assert.deepEqual(initial.admin, { active: 0, queued: 0, detached: 0, closed: false, ...limits, ...admin });
  return f;
}

async function refusal(response, code) {
  // fetch and raw HTTP fixtures expose different response representations.
  assert.equal(response.status, 503);
  const headers = response.headers;
  assert.equal(headers.get ? headers.get('retry-after') : headers['retry-after'], '1');
  assert.equal(headers.get ? headers.get('connection') : headers.connection, 'close');
  assert.deepEqual(response.body && typeof response.body.error === 'string' ? response.body : await response.json(), {
    error: code, executionAttempted: false, requestSubmitted: false, retryAfterMs: 1000,
  });
}

test('10 requests/second stays bounded before parsing, promotes FIFO, then recovers', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const held = f.rawCall('run-command', { command: 'fixture-blocker' }, { hold: true });
  await eventually(async () => (await f.snapshot()).mcp.active === 1);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss, peakActive = 0, peakQueued = 0;
  const burst = [];
  for (let i = 0; i < 10; i++) {
    burst.push(f.rawCall('run-command', { command: 'fixture-burst-' + i }));
    await delay(100);
    const { mcp, admin } = await f.snapshot();
    peakActive = Math.max(peakActive, mcp.active); peakQueued = Math.max(peakQueued, mcp.queued);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.ok(mcp.active <= 1 && mcp.queued <= 2 && mcp.detached <= 1);
    assert.equal(admin.active, 0);
  }
  assert.equal(peakActive, 1); assert.equal(peakQueued, 2);
  assert.equal(f.queue.listAll().length, 0, 'queued requests must not reach submission or SDK handling');
  const unauthenticated = f.rawCall('run-command', { command: 'fixture-no-authority' }, { headers: { Authorization: 'Bearer invalid-fixture-token' } });
  assert.equal((await unauthenticated.response).status, 401, 'authentication remains ahead of saturated admission');
  for (const call of burst.slice(2)) await refusal(await call.response, 'REQUEST_QUEUE_FULL');
  held.finish();
  for (const call of [held, ...burst.slice(0, 2)]) assert.equal((await call.response).status, 200);
  assert.deepEqual(f.queue.listAll().map(job => job.command), ['fixture-blocker', 'fixture-burst-0', 'fixture-burst-1']);
  assert.equal(f.calls.length, 0, 'admission never grants command approval');
  await eventually(async () => { const { mcp } = await f.snapshot(); return mcp.active === 0 && mcp.queued === 0 && mcp.detached === 0; });
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  t.diagnostic(JSON.stringify({ arrivals: 10, intervalMs: 100, peakActive, peakQueued, baselineRss, peakRss,
    observation: 'test-process RSS samples only; no hard RSS limit or historical outage causality claim' }));
});

test('waiting deadline refuses unstarted work and a later release does not submit it', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mcp: { maxWaitMs: 250 } });
  const held = f.rawCall('run-command', { command: 'fixture-blocker' }, { hold: true });
  await eventually(async () => (await f.snapshot()).mcp.active === 1);
  const expired = f.rawCall('run-command', { command: 'fixture-must-not-submit' });
  await refusal(await expired.response, 'REQUEST_QUEUE_TIMEOUT');
  assert.equal((await f.snapshot()).mcp.queued, 0);
  assert.equal(f.queue.listAll().length, 0); assert.equal(f.calls.length, 0);
  held.finish(); assert.equal((await held.response).status, 200);
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  assert.deepEqual(f.queue.listAll().map(job => job.command), ['fixture-blocker']);
});

test('disconnect while queued removes the unstarted body and recovers its FIFO capacity', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mcp: { maxQueued: 1 } });
  const held = f.rawCall('run-command', { command: 'fixture-blocker' }, { hold: true });
  await eventually(async () => (await f.snapshot()).mcp.active === 1);
  const abandoned = f.rawCall('run-command', { command: 'fixture-disconnected' });
  await eventually(async () => (await f.snapshot()).mcp.queued === 1);
  const disconnected = assert.rejects(abandoned.response);
  abandoned.req.destroy(Error('fixture client disconnected')); await disconnected;
  await eventually(async () => (await f.snapshot()).mcp.queued === 0);
  const survivor = f.rawCall('run-command', { command: 'fixture-survivor' });
  await eventually(async () => (await f.snapshot()).mcp.queued === 1);
  held.finish();
  assert.equal((await held.response).status, 200); assert.equal((await survivor.response).status, 200);
  assert.deepEqual(f.queue.listAll().map(job => job.command), ['fixture-blocker', 'fixture-survivor']);
  assert.equal(f.calls.length, 0);
});

test('administrator admission is bounded independently and MCP plus health remain responsive', { timeout: 15000 }, async t => {
  const f = await fixture(t, { admin: { maxQueued: 1 } });
  const held = f.slowAdmin();
  await eventually(async () => (await f.snapshot()).admin.active === 1);
  const queued = f.owner('/api/session');
  await eventually(async () => (await f.snapshot()).admin.queued === 1);
  await refusal(await f.owner('/api/session'), 'REQUEST_QUEUE_FULL');
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  const { mcp, admin } = await f.snapshot();
  assert.equal(mcp.queued, 0); assert.equal(admin.active, 1); assert.equal(admin.queued, 1);
  held.finish(); assert.equal((await held.response).status, 409);
  const recovered = await queued; assert.equal(recovered.status, 200); await recovered.json();
  await eventually(async () => { const { admin } = await f.snapshot(); return admin.active === 0 && admin.queued === 0; });
  assert.equal(f.calls.length, 0);
});

test('validated long waits have a separate finite budget without blocking control or weakening approval', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const job = (await f.call('run-command', { command: 'fixture-wait' })).structuredContent;
  const waited = f.rawCall('wait-for-request', { id: job.id, timeoutMs: 60000 });
  await eventually(async () => f.queue.requestWaiters.size === 1 && (await f.snapshot()).mcp.detached === 1);
  const overflow = await f.call('wait-for-request', { id: job.id, timeoutMs: 60000 });
  assert.equal(overflow.isError, true);
  assert.deepEqual(JSON.parse(overflow.content[0].text), {
    error_code: 'REQUEST_WAIT_LIMIT', stage: 'request_admission', executionAttempted: false, requestSubmitted: false, retryAfterMs: 1000,
  });
  assert.equal(f.queue.requestWaiters.size, 1, 'overflow must not register another wait subscription');
  assert.equal((await f.call('wait-for-request', { id: 'invalid' })).isError, true);
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  assert.equal((await f.owner('/api/requests')).status, 200);
  const control = await f.owner('/api/maintenance/capabilities', { method: 'POST' });
  assert.equal(control.status, 200); assert.equal((await control.json()).ownership, 'durable-v1');
  assert.equal((await f.owner('/api/' + job.id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer fixture-mcp' } })).status, 401);
  assert.equal((await f.owner('/api/' + job.id + '/approve', { method: 'POST', headers: { Origin: 'https://foreign.example.test' } })).status, 403);
  assert.equal((await f.call('ui-decide-request', { id: job.id, action: 'approve', ticket: 'blind-model-call' })).isError, true);
  assert.equal(f.calls.length, 0); assert.equal(f.queue.get(job.id).state, 'pending');
  assert.equal((await f.owner('/api/' + job.id + '/deny', { method: 'POST' })).status, 200);
  assert.equal((await waited.response).body.result.structuredContent.callback.event, 'denied');
  await eventually(async () => f.queue.requestWaiters.size === 0 && (await f.snapshot()).mcp.detached === 0);
  const next = (await f.call('run-command', { command: 'fixture-recovered-wait' })).structuredContent;
  const nextWait = f.rawCall('wait-for-request', { id: next.id, timeoutMs: 60000 });
  await eventually(() => f.queue.requestWaiters.size === 1);
  nextWait.req.destroy(Error('fixture long wait disconnected'));
  await eventually(async () => f.queue.requestWaiters.size === 0 && (await f.snapshot()).mcp.detached === 0);
  assert.equal(f.queue.get(next.id).state, 'pending'); assert.equal(f.calls.length, 0);
});

test('slow synchronous approval keeps control available; disconnect does not cancel or replay SSH', { timeout: 20000 }, async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { executeCommand: async () => { await gate; return { failed: false, texts: [] }; } });
  f.releases.add(finish);
  const job = (await f.call('run-command', { command: 'fixture-running' })).structuredContent;
  const other = (await f.call('run-command', { command: 'fixture-still-pending' })).structuredContent;
  const controller = new AbortController();
  const approval = f.owner('/api/' + job.id + '/approve', { method: 'POST', signal: controller.signal });
  approval.catch(() => {});
  await eventually(async () => f.calls.length === 1 && (await f.snapshot()).admin.detached === 1);
  await refusal(await f.owner('/api/' + other.id + '/approve', { method: 'POST' }), 'REQUEST_WAIT_LIMIT');
  assert.equal(f.queue.get(other.id).state, 'pending');
  const status = await f.owner('/api/' + job.id); assert.equal(status.status, 200); assert.equal((await status.json()).state, 'running');
  const control = await f.owner('/api/maintenance/capabilities', { method: 'POST' });
  assert.equal(control.status, 200); assert.equal((await control.json()).ownership, 'durable-v1');
  const queuedResponse = await f.owner('/api/' + other.id + '/approve', { method: 'POST', headers: { Prefer: 'respond-async' } });
  assert.equal(queuedResponse.status, 202); assert.equal(queuedResponse.headers.get('preference-applied'), 'respond-async');
  const queuedJob = await queuedResponse.json();
  assert.equal(queuedJob.id, other.id); assert.equal(queuedJob.state, 'queued'); assert.equal(queuedJob.approvalMode, 'owner');
  assert.equal(queuedJob.result, undefined); assert.deepEqual(f.calls, ['fixture-running']);
  assert.equal((await f.owner('/api/' + other.id + '/approve', { method: 'POST', headers: { Prefer: 'respond-async' } })).status, 409);
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  const disconnected = assert.rejects(approval); controller.abort(); await disconnected;
  assert.equal((await f.snapshot()).admin.detached, 1, 'the synchronous approval handler still owns its unfinished execution');
  assert.equal(f.queue.get(job.id).state, 'running'); assert.equal(f.calls.length, 1);
  const afterDisconnect = await f.owner('/api/' + job.id);
  assert.equal(afterDisconnect.status, 200); assert.equal((await afterDisconnect.json()).state, 'running');
  const cancelledResponse = await f.owner('/api/' + other.id + '/deny', { method: 'POST' });
  assert.equal(cancelledResponse.status, 200); assert.equal((await cancelledResponse.json()).state, 'denied');
  assert.equal(f.queue.get(other.id).state, 'denied'); assert.deepEqual(f.calls, ['fixture-running']);
  assert.equal((await f.queue.wait(other.id)).state, 'denied', 'queued cancellation settles its completion promise');
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
  assert.equal((await f.snapshot()).admin.detached, 1, 'control responses do not release the execution-owned lease');
  finish(); await f.queue.wait(job.id);
  assert.equal(f.queue.get(job.id).state, 'completed'); assert.deepEqual(f.calls, ['fixture-running']);
  assert.equal(f.queue.get(other.id).state, 'denied', 'cancelled queued work never starts after the active job completes');
  await eventually(async () => { const { admin } = await f.snapshot(); return admin.active === 0 && admin.queued === 0 && admin.detached === 0; });
  assert.equal((await f.owner('/api/' + job.id + '/approve', { method: 'POST' })).status, 409);
  assert.equal((await f.owner('/api/' + other.id + '/approve', { method: 'POST', headers: { Prefer: 'respond-async' } })).status, 409);
  assert.equal(f.calls.length, 1);
  await eventually(async () => (await f.snapshot()).admin.detached === 0);
});

test('shutdown rejects queued bodies without promotion and releases long-wait subscriptions', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const job = (await f.call('run-command', { command: 'fixture-before-shutdown' })).structuredContent;
  const waited = f.rawCall('wait-for-request', { id: job.id, timeoutMs: 60000 });
  await eventually(async () => f.queue.requestWaiters.size === 1 && (await f.snapshot()).mcp.detached === 1);
  const held = f.rawCall('run-command', { command: 'fixture-unfinished' }, { hold: true });
  await eventually(async () => (await f.snapshot()).mcp.active === 1);
  const queued = f.rawCall('run-command', { command: 'fixture-never-promoted' });
  await eventually(async () => (await f.snapshot()).mcp.queued === 1);
  const closing = f.app.close(); assert.equal(f.app.close(), closing);
  await refusal(await queued.response, 'REQUEST_QUEUE_CLOSED');
  await waited.response.catch(() => {});
  await closing;
  assert.equal(f.queue.requestWaiters.size, 0);
  assert.deepEqual(f.queue.listAll().map(job => job.command), ['fixture-before-shutdown']);
  assert.equal(f.calls.length, 0);
  await eventually(() => held.req.destroyed, 'shutdown must close the unfinished HTTP body');
});

test('JSON-RPC batches cannot detach a shared lease or dispatch multiple command submissions', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const job = (await f.call('run-command', { command: 'fixture-existing-pending' })).structuredContent;
  const before = f.queue.listAll();
  let waitDispatches = 0, submissionDispatches = 0;
  const wait = f.queue.waitForRequest.bind(f.queue), submit = f.queue.submitOperation.bind(f.queue);
  f.queue.waitForRequest = (...args) => { waitDispatches++; return wait(...args); };
  f.queue.submitOperation = (...args) => { submissionDispatches++; return submit(...args); };
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const batches = [
    [call(2001, 'wait-for-request', { id: job.id, timeoutMs: 60000 }), call(2002, 'run-command', { command: 'fixture-after-detach' })],
    [call(2003, 'run-command', { command: 'fixture-batch-first' }), call(2004, 'run-command', { command: 'fixture-batch-second' })],
  ];
  for (const contentType of ['application/json', 'Application/JSON', 'application/json;charset=utf-8']) for (const batch of batches) {
    const response = await f.rawBatch(batch, contentType).response;
    assert.equal(response.status, 400);
    assert.equal(response.body.jsonrpc, '2.0');
    assert.equal(response.body.error.code, -32600);
    assert.deepEqual(response.body.error.data, {
      error_code: 'MCP_BATCH_NOT_SUPPORTED', executionAttempted: false, requestSubmitted: false,
    });
    assert.equal(waitDispatches, 0, 'batch rejection must precede wait dispatch, including transient subscriptions');
    assert.equal(submissionDispatches, 0, 'batch rejection must precede command registration');
    assert.equal(f.queue.requestWaiters.size, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.queue.listAll(), before);
    await eventually(async () => { const { mcp } = await f.snapshot(); return mcp.active === 0 && mcp.queued === 0 && mcp.detached === 0; });
  }
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
});

test('bounded JSON body parsing rejects primitives, invalid encoding, oversize and wrong MIME without effects', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const cases = [
    { label: 'null is passed to SDK validation', body: 'null', status: 400 },
    { label: 'false is passed to SDK validation', body: 'false', status: 400 },
    { label: 'zero is passed to SDK validation', body: '0', status: 400 },
    { label: 'invalid JSON', body: '{', status: 400, code: -32700 },
    // Replacing malformed UTF-8 would produce syntactically valid JSON; strict decoding must reject it.
    { label: 'invalid UTF-8', body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), status: 400, code: -32700 },
    { label: 'one byte over 1 MiB', body: Buffer.alloc(1024 * 1024 + 1, 0x20), status: 413, close: true },
    { label: 'wrong MIME', body: '{}', contentType: 'text/plain', status: 415 },
  ];
  for (const scenario of cases) {
    const response = await f.rawBody(scenario.body, scenario.contentType).response;
    assert.equal(response.status, scenario.status, scenario.label);
    assert.equal(response.body.jsonrpc, '2.0', scenario.label);
    if (scenario.code !== undefined) assert.equal(response.body.error.code, scenario.code, scenario.label);
    if (scenario.close) assert.equal(response.headers.connection, 'close', scenario.label);
    assert.equal(f.queue.listAll().length, 0, scenario.label);
    assert.equal(f.queue.requestWaiters.size, 0, scenario.label); assert.equal(f.calls.length, 0, scenario.label);
    await eventually(async () => { const { mcp } = await f.snapshot(); return mcp.active === 0 && mcp.queued === 0 && mcp.detached === 0; });
  }
  assert.equal((await f.call('show-ui-probe')).isError, undefined);
});
