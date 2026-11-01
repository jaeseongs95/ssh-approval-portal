import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequestAdmission, RequestAdmissionError } from '../src/application/request-admission.mjs';

// engineering-test-plan: node:test public-API unit cases; no SSH/HTTP/runtime mocks.
// INV-BOUND/FIFO-DEADLINE -> ordered grants, fixed counts and no expired/cancelled grant;
// INV-SETTLE -> release/abort/timeout cleanup; INV-CONTROL -> bounded atomic detach.
// INV-AUTHORITY is an HTTP/MCP integration obligation outside this primitive.
// Local product execution is prohibited: CI must supply engineering-test-proof/result (NOT_RUN here).
const error = code => value => value instanceof RequestAdmissionError && value.code === code;

test('admission limits have bounded defaults and reject invalid configuration', () => {
  assert.deepEqual(createRequestAdmission().snapshot(), {
    active: 0, queued: 0, detached: 0, closed: false,
    maxActive: 8, maxQueued: 32, maxDetached: 64, maxWaitMs: 5000,
  });
  for (const limits of [
    { maxActive: 0 }, { maxActive: 1.5 }, { maxActive: Infinity },
    { maxQueued: -1 }, { maxQueued: NaN }, { maxQueued: '2' },
    { maxDetached: -1 }, { maxDetached: Number.MAX_SAFE_INTEGER + 1 },
    { maxWaitMs: 0 }, { maxWaitMs: 2_147_483_648 }, { maxWaitMs: null },
  ]) assert.throws(() => createRequestAdmission(limits), /Invalid request admission limits/);
});

test('bounded FIFO admission never lets a newcomer pass a waiter and release is idempotent', async t => {
  const admission = createRequestAdmission({ maxActive: 1, maxQueued: 2 });
  t.after(() => admission.close());
  const first = await admission.acquire();
  const order = [];
  const second = admission.acquire().then(value => { order.push('second'); return value; });
  const third = admission.acquire().then(value => { order.push('third'); return value; });
  await assert.rejects(admission.acquire(), error('REQUEST_QUEUE_FULL'));
  first.release();
  first.release();
  const fourth = admission.acquire().then(value => { order.push('fourth'); return value; });
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().queued, 2);
  (await second).release();
  (await third).release();
  (await fourth).release();
  assert.deepEqual(order, ['second', 'third', 'fourth']);
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().queued, 0);
});

test('queued and pre-aborted requests are removed while active cancellation retains its slot', async t => {
  const admission = createRequestAdmission({ maxActive: 1, maxQueued: 2 });
  t.after(() => admission.close());
  const activeAbort = new AbortController(), waitingAbort = new AbortController();
  const first = await admission.acquire({ signal: activeAbort.signal });
  const removed = t.mock.method(waitingAbort.signal, 'removeEventListener');
  const cancelled = assert.rejects(admission.acquire({ signal: waitingAbort.signal }), value =>
    error('REQUEST_ABORTED')(value) && value.message === 'Request was aborted');
  const next = admission.acquire();
  waitingAbort.abort(new Error('private cancellation reason'));
  await cancelled;
  assert.equal(removed.mock.callCount(), 1);
  await assert.rejects(admission.acquire({ signal: waitingAbort.signal }), error('REQUEST_ABORTED'));
  activeAbort.abort();
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().queued, 1);
  first.release();
  (await next).release();
  assert.equal(admission.snapshot().active, 0);
});

test('a granted waiter owns its slot even if aborted before its Promise continuation', async t => {
  const admission = createRequestAdmission({ maxActive: 1 });
  t.after(() => admission.close());
  const first = await admission.acquire(), controller = new AbortController();
  const removed = t.mock.method(controller.signal, 'removeEventListener');
  const pending = admission.acquire({ signal: controller.signal });
  first.release();
  assert.equal(removed.mock.callCount(), 1);
  controller.abort();
  assert.equal(admission.snapshot().active, 1);
  const granted = await pending;
  granted.release();
  granted.release();
  assert.equal(admission.snapshot().active, 0);
});

test('queue timeout removes the waiter without releasing work still owned by another request', async t => {
  const admission = createRequestAdmission({ maxActive: 1, maxWaitMs: 5 });
  t.after(() => admission.close());
  const first = await admission.acquire();
  const controller = new AbortController();
  const removed = t.mock.method(controller.signal, 'removeEventListener');
  await assert.rejects(admission.acquire({ signal: controller.signal }), error('REQUEST_QUEUE_TIMEOUT'));
  assert.equal(removed.mock.callCount(), 1);
  controller.abort();
  assert.equal(admission.snapshot().queued, 0);
  assert.equal(admission.snapshot().active, 1);
  first.release();
});

test('a stalled timer cannot grant an expired waiter when release runs before the timer callback', async t => {
  const admission = createRequestAdmission({ maxActive: 1, maxWaitMs: 2 });
  t.after(() => admission.close());
  const first = await admission.acquire();
  const controller = new AbortController();
  const timedOut = assert.rejects(admission.acquire({ signal: controller.signal }), error('REQUEST_QUEUE_TIMEOUT'));
  const deadline = performance.now() + 5;
  while (performance.now() < deadline) { /* Keep the expiry callback pending. */ }
  first.release();
  controller.abort();
  const next = await admission.acquire();
  await timedOut;
  assert.equal(admission.snapshot().active, 1);
  next.release();
});

test('detach reserves separate bounded capacity before promoting FIFO work and failure retains active ownership', async t => {
  const admission = createRequestAdmission({ maxActive: 1, maxQueued: 1, maxDetached: 1 });
  t.after(() => admission.close());
  const first = await admission.acquire();
  const waiting = admission.acquire();
  first.detach();
  first.detach();
  assert.equal(admission.snapshot().detached, 1);
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().queued, 0);
  const second = await waiting;
  assert.throws(() => second.detach(), error('REQUEST_WAIT_LIMIT'));
  assert.equal(admission.snapshot().active, 1);
  first.release();
  first.release();
  assert.equal(admission.snapshot().detached, 0);
  assert.equal(admission.snapshot().active, 1);
  second.detach();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().detached, 1);
  second.release();
  assert.equal(admission.snapshot().detached, 0);
});

test('close rejects queued and future requests while owners retain and release active and detached slots', async () => {
  const admission = createRequestAdmission({ maxActive: 1, maxDetached: 1 });
  const detached = await admission.acquire();
  detached.detach();
  const active = await admission.acquire();
  const closed = assert.rejects(admission.acquire(), error('REQUEST_QUEUE_CLOSED'));
  admission.close();
  admission.close();
  await closed;
  await assert.rejects(admission.acquire(), error('REQUEST_QUEUE_CLOSED'));
  assert.throws(() => active.detach(), error('REQUEST_QUEUE_CLOSED'));
  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.snapshot().detached, 1);
  assert.equal(admission.snapshot().queued, 0);
  active.release();
  detached.release();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().detached, 0);
  assert.equal(admission.snapshot().closed, true);
});

test('zero queued and detached capacity rejects immediately without changing active ownership', async () => {
  const admission = createRequestAdmission({ maxActive: 2, maxQueued: 0, maxDetached: 0 });
  const active = await admission.acquire();
  const other = await admission.acquire();
  await assert.rejects(admission.acquire(), error('REQUEST_QUEUE_FULL'));
  assert.throws(() => active.detach(), error('REQUEST_WAIT_LIMIT'));
  assert.equal(admission.snapshot().active, 2);
  active.release();
  assert.equal(admission.snapshot().active, 1);
  other.release();
  assert.equal(admission.snapshot().active, 0);
  admission.close();
});
