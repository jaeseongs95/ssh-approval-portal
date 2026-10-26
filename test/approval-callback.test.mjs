import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createTargetRouter } from '../src/application/target-router.mjs';
import { createApplication } from '../app.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function queueFixture(t, options = {}) {
  let effects = 0;
  const controller = new AbortController();
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'fixture',
    executeOperation: async () => { effects++; return { failed: false, texts: [] }; }, ...options });
  t.after(() => controller.abort());
  return { queue, controller, wait: (id, options) => queue.waitForRequest(id, { signal: controller.signal, ...options }), get effects() { return effects; } };
}

async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition did not become true'); await delay(5); }
}

test('approval callback arrives before execution completion; late waits observe the existing result', async t => {
  let finish;
  const f = queueFixture(t, { executeOperation: () => new Promise(resolve => { finish = resolve; }) });
  const job = f.queue.submit('fixture-command');
  const approved = f.wait(job.id), completed = f.wait(job.id, { until: 'completion' });
  assert.equal(f.queue.start(job.id).state, 'running');
  const first = await approved;
  assert.equal(first.event, 'approved'); assert.equal(first.job.state, 'running'); assert.equal(first.job.approvalMode, 'owner');
  assert.equal((await f.wait(job.id)).event, 'approved');
  finish({ failed: false, texts: [] });
  assert.equal((await completed).event, 'completed');
  assert.equal((await f.wait(job.id)).job.state, 'completed');
  assert.equal(f.queue.requestWaiters.size, 0);
});

test('evaluation does not signal approval; automatic policy approval and repeated waiters do not execute twice', async t => {
  const f = queueFixture(t), job = f.queue.submit('fixture-command');
  f.queue.beginEvaluation(job.id);
  const waits = Array.from({ length: 3 }, () => f.wait(job.id));
  f.queue.finishEvaluation(job.id);
  assert.equal(f.queue.requestWaiters.size, 3);
  f.queue.setDecision(job.id, { decision: 'execute' }); f.queue.startCommand(job.id);
  const events = await Promise.all(waits);
  for (const result of events) { assert.equal(result.event, 'approved'); assert.equal(result.job.approvalMode, 'automatic'); }
  await f.queue.wait(job.id); assert.equal(f.effects, 1);
  assert.throws(() => f.queue.start(job.id), /pending/);
});

test('denial, failed execution, unknown source and missing IDs are not approval success', async t => {
  const f = queueFixture(t), denied = f.queue.submit('fixture-command');
  const pending = f.wait(denied.id); f.queue.deny(denied.id);
  assert.equal((await pending).event, 'denied'); assert.equal(f.effects, 0);
  assert.equal((await f.wait(denied.id)).event, 'denied');
  assert.equal((await f.wait('f'.repeat(48))).event, 'missing');
  const unknown = f.queue.submit('fixture-command'), waiting = f.wait(unknown.id);
  f.queue.abortEvaluation(unknown.id); assert.equal((await waiting).event, 'unknown');
  const g = queueFixture(t, { executeOperation: async () => ({ failed: true, texts: [] }) }), job = g.queue.submit('fixture-command');
  const terminal = g.wait(job.id, { until: 'completion' }); g.queue.start(job.id);
  assert.equal((await terminal).event, 'failed');
});

test('audit or persistence failure cannot send approval or execute a command', async t => {
  for (const phase of ['audit', 'persist']) {
    const f = queueFixture(t, { audit: event => { if (phase === 'audit' && event.action === 'approved') throw Error('protected failure'); } });
    const job = f.queue.submit('fixture-command');
    if (phase === 'persist') f.queue.track(job.id, () => { throw Error('protected persistence failure'); });
    const wait = f.wait(job.id, { timeoutMs: 10 });
    assert.throws(() => f.queue.start(job.id));
    const result = await wait;
    assert.equal(result.event, phase === 'audit' ? 'timeout' : 'unknown');
    assert.equal(result.job.approvalMode, undefined); assert.equal(f.effects, 0); assert.equal(f.queue.requestWaiters.size, 0);
  }
});

test('expiry wakes without a queue reaper, while timeout leaves the original request pending', async t => {
  const f = queueFixture(t), job = f.queue.submit('fixture-command');
  assert.equal((await f.wait(job.id, { timeoutMs: 5 })).event, 'timeout');
  assert.equal(f.queue.get(job.id).state, 'pending'); assert.equal(f.effects, 0);
  const expired = f.queue.submitOperation({ kind: 'command', command: 'fixture-command' }, 'privileged', { expiresAt: Date.now() + 15 });
  const result = await f.wait(expired.id, { timeoutMs: 1000 });
  assert.equal(result.event, 'expired'); assert.equal(result.job.state, 'expired'); assert.equal(f.effects, 0);
  assert.equal((await f.wait(expired.id)).event, 'expired');
  let now = 1000;
  const late = queueFixture(t, { now: () => now }), unseen = late.queue.submit('fixture-command');
  late.queue.beginEvaluation(unseen.id); now = unseen.expiresAt;
  assert.equal((await late.wait(unseen.id)).event, 'expired'); assert.equal(late.queue.requestWaiters.size, 0); assert.equal(late.effects, 0);
});

test('abort, saturation and invalid deadlines release subscriptions without cancelling the operation', async t => {
  const f = queueFixture(t), job = f.queue.submit('fixture-command');
  for (const timeoutMs of [0, -1, 60001, 1.5, NaN, Infinity]) assert.throws(() => f.wait(job.id, { timeoutMs }));
  assert.throws(() => f.wait(job.id, { until: 'untrusted' }));
  const maxAbort = new AbortController(), maxWait = f.wait(job.id, { timeoutMs: 60000, signal: maxAbort.signal });
  const maxRejected = assert.rejects(maxWait); maxAbort.abort(); await maxRejected;
  assert.throws(() => f.wait(job.id, { signal: maxAbort.signal })); assert.equal(f.queue.requestWaiters.size, 0);
  const abort = new AbortController();
  const waits = Array.from({ length: 64 }, () => f.wait(job.id, { signal: abort.signal }));
  const settled = Promise.allSettled(waits);
  assert.throws(() => f.wait(job.id), /limit/); assert.equal(getEventListeners(abort.signal, 'abort').length, 64);
  abort.abort(); assert.ok((await settled).every(value => value.status === 'rejected'));
  assert.equal(f.queue.requestWaiters.size, 0); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const next = f.wait(job.id); f.queue.start(job.id); assert.equal((await next).event, 'approved');
  await f.queue.wait(job.id); assert.equal(f.effects, 1);
});

test('router delegates to the exact owning queue and refuses ambiguous IDs', async t => {
  const a = queueFixture(t), b = queueFixture(t), job = b.queue.submit('fixture-command');
  const router = createTargetRouter([{ id: 'a', enabled: true, queue: a.queue }, { id: 'b', enabled: true, queue: b.queue }], { defaultTarget: 'a' });
  const waited = router.queue.waitForRequest(job.id, { timeoutMs: 1000 });
  assert.equal(a.queue.requestWaiters.size, 0); assert.equal(b.queue.requestWaiters.size, 1);
  b.queue.deny(job.id); assert.equal((await waited).event, 'denied');
  assert.equal((await router.queue.waitForRequest('e'.repeat(48))).event, 'missing');
  a.queue.restore(job); assert.throws(() => router.queue.waitForRequest(job.id), /Ambiguous/);
  assert.equal(a.effects + b.effects, 0);
});

async function httpFixture(t, executeCommand, audit = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'approval-callback-'));
  const app = await createApplication({ registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'fixture', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }), executeCommand, audit, transferRoot: root, uiHtml: '<html></html>',
    env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-owner', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_ADMIN_ORIGIN: 'https://owner.example.test' } });
  await Promise.all([app.mcpHttp, app.adminHttp].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const client = new Client({ name: 'callback-contract', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + app.mcpHttp.address().port + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
  t.after(async () => { await client.close(); await app.close(); assert.ok(root.startsWith(join(tmpdir(), 'approval-callback-'))); await rm(root, { recursive: true, force: true }); });
  return { app, client, queue: app.targets.select('default').queue,
    call: (name, args) => client.callTool({ name, arguments: args }),
    owner: (id, action) => fetch('http://127.0.0.1:' + app.adminHttp.address().port + '/api/' + id + '/' + action, { method: 'POST', headers: { Authorization: 'Bearer fixture-owner', Origin: 'https://owner.example.test' } }) };
}

test('real SDK HTTP call resumes on owner approval, then completion returns only the stored redacted output reference', { timeout: 20000 }, async t => {
  let finish, effects = 0;
  const f = await httpFixture(t, () => { effects++; return new Promise(resolve => { finish = resolve; }); });
  const job = (await f.call('run-command', { command: 'fixture-command' })).structuredContent;
  assert.equal(job.approvalCallback.tool, 'wait-for-request'); assert.equal(job.approvalCallback.arguments.id, job.id);
  const wait = f.call('wait-for-request', { id: job.id, until: 'approval', timeoutMs: 5000 });
  await eventually(() => f.queue.requestWaiters.size === 1);
  const approvedResponse = f.owner(job.id, 'approve');
  const approved = (await wait).structuredContent;
  assert.deepEqual(approved.callback, { contract: 'approval-callback-v1', until: 'approval', event: 'approved', approved: true, terminal: false, executionSucceeded: false });
  assert.equal(approved.state, 'running'); assert.equal(effects, 1);
  const completed = f.call('wait-for-request', { id: job.id, until: 'completion', timeoutMs: 5000 });
  await eventually(() => f.queue.requestWaiters.size === 1);
  finish({ failed: false, texts: ['PRIVATE-output-body'] });
  assert.equal((await approvedResponse).status, 200);
  const result = await completed;
  assert.equal(result.structuredContent.callback.executionSucceeded, true); assert.equal(result.structuredContent.callback.event, 'completed');
  assert.equal(result.structuredContent.result.structuredContent.output.state, 'ready');
  assert.equal(JSON.stringify(result).includes('PRIVATE-output-body'), false); assert.equal(f.queue.requestWaiters.size, 0);
});

test('MCP deny, timeout, unknown ID and SDK cancellation preserve zero execution and bounded waits', { timeout: 20000 }, async t => {
  let effects = 0;
  const f = await httpFixture(t, async () => { effects++; return { failed: false, texts: [] }; });
  const job = (await f.call('run-command', { command: 'fixture-command' })).structuredContent;
  const wait = f.call('wait-for-request', { id: job.id, timeoutMs: 5000 });
  await eventually(() => f.queue.requestWaiters.size === 1); assert.equal((await f.owner(job.id, 'deny')).status, 200);
  const denied = (await wait).structuredContent; assert.equal(denied.callback.event, 'denied'); assert.equal(denied.callback.approved, false);
  const unknown = (await f.call('wait-for-request', { id: 'f'.repeat(48) })).structuredContent; assert.equal(unknown.callback.event, 'missing');
  const pending = (await f.call('run-command', { command: 'fixture-command' })).structuredContent;
  assert.equal((await f.call('wait-for-request', { id: pending.id, timeoutMs: 5 })).structuredContent.callback.event, 'timeout');
  const controller = new AbortController();
  const waiting = f.client.callTool({ name: 'wait-for-request', arguments: { id: pending.id, timeoutMs: 500 } }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(waiting); await eventually(() => f.queue.requestWaiters.size === 1); controller.abort(); await rejection;
  await eventually(() => f.queue.requestWaiters.size === 0); assert.equal(f.queue.get(pending.id).state, 'pending'); assert.equal(effects, 0);
});

test('actual HTTP disconnect and application shutdown release waiting callbacks', { timeout: 15000 }, async t => {
  const f = await httpFixture(t, async () => assert.fail('waiting must not execute SSH'));
  const job = (await f.call('run-command', { command: 'fixture-command' })).structuredContent;
  const controller = new AbortController();
  const waiting = fetch('http://127.0.0.1:' + f.app.mcpHttp.address().port + '/mcp', {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer fixture-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'wait-for-request', arguments: { id: job.id, timeoutMs: 60000 } } }),
  });
  const rejected = assert.rejects(waiting);
  await eventually(() => f.queue.requestWaiters.size === 1); controller.abort(); await rejected;
  await eventually(() => f.queue.requestWaiters.size === 0);
  const next = f.call('wait-for-request', { id: job.id, timeoutMs: 60000 });
  await eventually(() => f.queue.requestWaiters.size === 1);
  const closed = f.app.close(); await next.catch(() => {}); await closed;
  assert.equal(f.queue.requestWaiters.size, 0);
});

test('terminal audit or persistence failure remains visible and never retries completed effects', async t => {
  for (const phase of ['audit', 'persist']) {
    const f = queueFixture(t, { audit: event => { if (phase === 'audit' && event.action === 'completed') throw Error('protected audit failure'); } });
    const job = f.queue.submit('fixture-command');
    if (phase === 'persist') f.queue.track(job.id, value => { if (value.state === 'completed') throw Error('protected persistence failure'); });
    const completed = f.wait(job.id, { until: 'completion' }); f.queue.start(job.id);
    const result = await completed;
    assert.equal(result.event, 'completed'); assert.match(result.job.auditError, /must not be retried/);
    assert.equal(f.effects, 1); assert.equal(f.queue.requestWaiters.size, 0);
  }
});

test('approval and completion race with abort exactly once, including duplicate state notifications', async t => {
  const f = queueFixture(t), job = f.queue.submit('fixture-command'), controller = new AbortController();
  let deliveries = 0;
  const waited = f.wait(job.id, { signal: controller.signal }).then(result => { deliveries++; return result; });
  f.queue.start(job.id); f.queue.notifyRequest(f.queue.jobs.get(job.id)); controller.abort();
  assert.equal((await waited).event, 'approved'); await f.queue.wait(job.id);
  f.queue.notifyRequest(f.queue.jobs.get(job.id)); assert.equal(deliveries, 1);
  const before = new AbortController(), beforeJob = f.queue.submit('fixture-command');
  const beforeWait = f.wait(beforeJob.id, { signal: before.signal }); const beforeRejected = assert.rejects(beforeWait);
  before.abort(); f.queue.start(beforeJob.id); await beforeRejected; await f.queue.wait(beforeJob.id);
  assert.equal(f.queue.requestWaiters.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(f.effects, 2);
  assert.equal(getEventListeners(before.signal, 'abort').length, 0);
  for (const order of ['completion-first', 'abort-first', 'same-tick']) {
    let finish, effects = 0;
    const g = queueFixture(t, { executeOperation: () => { effects++; return new Promise(resolve => { finish = resolve; }); } });
    const original = g.queue.submit('fixture-command'), cancel = new AbortController();
    const result = g.wait(original.id, { until: 'completion', signal: cancel.signal });
    const observed = result.then(value => ({ value }), error => ({ error }));
    g.queue.start(original.id); await Promise.resolve();
    if (order === 'abort-first') cancel.abort();
    finish({ failed: false, texts: [] });
    if (order === 'completion-first') await g.queue.wait(original.id);
    cancel.abort();
    const outcome = await observed; await g.queue.wait(original.id);
    if (order === 'completion-first') assert.equal(outcome.value.event, 'completed'); else assert.ok(outcome.error);
    assert.equal(g.queue.requestWaiters.size, 0); assert.equal(getEventListeners(cancel.signal, 'abort').length, 0); assert.equal(effects, 1);
  }
});

test('MCP terminal audit error explicitly refuses execution-success signalling', { timeout: 15000 }, async t => {
  for (const phase of ['audit', 'persist']) {
    let effects = 0;
    const f = await httpFixture(t, async () => { effects++; return { failed: false, texts: [] }; }, event => { if (phase === 'audit' && event.action === 'completed') throw Error('private audit failure'); });
    const job = (await f.call('run-command', { command: 'fixture-command' })).structuredContent;
    if (phase === 'persist') f.queue.track(job.id, value => { if (value.state === 'completed') throw Error('private persistence failure'); });
    const completed = f.call('wait-for-request', { id: job.id, until: 'completion', timeoutMs: 5000 });
    await eventually(() => f.queue.requestWaiters.size === 1); assert.equal((await f.owner(job.id, 'approve')).status, 200);
    const result = (await completed).structuredContent;
    assert.equal(result.callback.approved, true); assert.equal(result.callback.executionSucceeded, false);
    assert.match(result.auditError, /must not be retried/); assert.equal(effects, 1); assert.equal(f.queue.requestWaiters.size, 0);
  }
});

test('timeout and completion ordering settle once under the same clock tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const order of ['timeout-first', 'completion-first']) {
    let finish, effects = 0, deliveries = 0;
    const f = queueFixture(t, { executeOperation: () => { effects++; return new Promise(resolve => { finish = resolve; }); } });
    const job = f.queue.submit('fixture-command');
    const result = f.wait(job.id, { until: 'completion', timeoutMs: 10 }).then(value => { deliveries++; return value; });
    f.queue.start(job.id); await Promise.resolve();
    if (order === 'timeout-first') t.mock.timers.tick(10);
    finish({ failed: false, texts: [] }); await f.queue.wait(job.id);
    if (order === 'completion-first') t.mock.timers.tick(10);
    assert.equal((await result).event, order === 'timeout-first' ? 'timeout' : 'completed');
    assert.equal(deliveries, 1); assert.equal(f.queue.requestWaiters.size, 0);
    assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0); assert.equal(effects, 1);
  }
});
