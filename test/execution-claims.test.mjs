import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaims } from '../src/application/target-router.mjs';

// engineering-test-plan: public synchronous claim/wait ownership and microtask wakeups.
// Queue FIFO, job expiry and execution are caller responsibilities and tested in integration.
// Product tests run in CI only; this file is not executed locally.

test('claim limits and subscribers reject invalid configuration without allocating work', () => {
  for (const limit of [undefined, 0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createClaims(limit), /Invalid execution claim limits/);
  }
  for (const maxWaiting of [-1, 0.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createClaims(2, { maxWaiting }), /Invalid execution claim limits/);
  }
  assert.throws(() => createClaims(2, { onSubscriberError: null }), /Invalid execution claim error handler/);
  const claims = createClaims(1);
  for (const callback of [null, undefined, true, {}]) {
    assert.throws(() => claims.subscribe(callback), /Invalid execution claim subscriber/);
  }
  assert.equal(claims.busy(), false);
  assert.equal(claims.waiting(), 0);
});

test('active claim limit and synchronous idempotent release preserve the existing contract', () => {
  const claims = createClaims(2);
  const first = claims(), second = claims();
  assert.equal(claims.busy(), true);
  assert.throws(() => claims(), /Global concurrency limit reached/);
  first();
  assert.equal(claims.busy(), false);
  first();
  const third = claims();
  assert.equal(claims.busy(), true, 'A duplicate release must not create an extra active slot');
  assert.throws(() => claims(), /Global concurrency limit reached/);
  second(); third();
  assert.equal(claims.busy(), false);
  assert.equal(claims.waiting(), 0);
});

test('global waiting defaults to 32 and is independent of active ownership', () => {
  const claims = createClaims(1), active = claims();
  const releases = Array.from({ length: 32 }, () => claims.reserveWait());
  assert.equal(claims.waiting(), 32);
  assert.equal(claims.busy(), true);
  assert.throws(() => claims.reserveWait(), error => error.code === 'EXECUTION_QUEUE_FULL' && error.message === 'Execution queue is full');
  releases[0](); releases[0]();
  assert.equal(claims.waiting(), 31);
  assert.equal(claims.busy(), true, 'Releasing wait ownership must not release active work');
  const replacement = claims.reserveWait();
  assert.equal(claims.waiting(), 32);
  active();
  assert.equal(claims.busy(), false);
  assert.equal(claims.waiting(), 32, 'Releasing active work must not discard waiting requests');
  for (const release of releases) release();
  replacement();
  assert.equal(claims.waiting(), 0);
});

test('zero waiting slots reject before ownership and custom wait limits recover exactly once', () => {
  const disabled = createClaims(1, { maxWaiting: 0 });
  assert.throws(() => disabled.reserveWait(), { code: 'EXECUTION_QUEUE_FULL' });
  assert.equal(disabled.waiting(), 0);
  const claims = createClaims(1, { maxWaiting: 1 }), release = claims.reserveWait();
  assert.throws(() => claims.reserveWait(), { code: 'EXECUTION_QUEUE_FULL' });
  release(); release();
  assert.equal(claims.waiting(), 0);
  const replacement = claims.reserveWait();
  assert.equal(claims.waiting(), 1);
  replacement();
});

test('active and wait releases coalesce into one asynchronous notification to every subscriber', async () => {
  const claims = createClaims(2), seen = [];
  claims.subscribe(() => seen.push(['first', claims.busy(), claims.waiting()]));
  claims.subscribe(() => seen.push(['second', claims.busy(), claims.waiting()]));
  const first = claims(), second = claims(), waiting = claims.reserveWait();
  first(); second(); waiting(); first(); waiting();
  assert.deepEqual(seen, [], 'Releases never reenter a queue synchronously');
  await Promise.resolve();
  assert.deepEqual(seen, [['first', false, 0], ['second', false, 0]]);
  const next = claims();
  next();
  await Promise.resolve();
  assert.equal(seen.length, 4, 'A later release creates a new notification');
});

test('unsubscribe removes only its registration and can cancel a queued wakeup', async () => {
  const claims = createClaims(1);
  let calls = 0;
  const listener = () => { calls++; };
  const unsubscribe = claims.subscribe(listener), second = claims.subscribe(listener);
  const release = claims();
  release(); unsubscribe(); unsubscribe();
  await Promise.resolve();
  assert.equal(calls, 1, 'Identical callback registrations have separate ownership');
  const next = claims();
  next(); second();
  await Promise.resolve();
  assert.equal(calls, 1);
});

test('callback and reporting failures never suppress another queue wakeup or corrupt ownership', async () => {
  const original = Error('synthetic subscriber failure'), observed = [], seen = [];
  const claims = createClaims(1, { onSubscriberError: error => { observed.push(error); throw Error('synthetic observer failure'); } });
  claims.subscribe(() => { throw original; });
  claims.subscribe(() => seen.push([claims.busy(), claims.waiting()]));
  const release = claims(), waiting = claims.reserveWait();
  release(); waiting();
  await Promise.resolve();
  assert.deepEqual(observed, [original], 'The error handler receives the original exception identity');
  assert.deepEqual(seen, [[false, 0]]);
  assert.equal(claims.busy(), false);
  assert.equal(claims.waiting(), 0);
});

test('a release inside a notification schedules another pass without recursive callback execution', async () => {
  const claims = createClaims(1), states = [];
  let inCallback = false;
  claims.subscribe(() => {
    assert.equal(inCallback, false);
    inCallback = true;
    states.push(claims.busy());
    if (states.length === 1) { const release = claims(); release(); }
    inCallback = false;
  });
  const release = claims();
  release();
  await Promise.resolve();
  assert.equal(states.length, 1);
  await Promise.resolve();
  assert.deepEqual(states, [false, false]);
});
