import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createClaims } from '../src/application/target-router.mjs';
import { createCommandService } from '../src/application/commands.mjs';
import { dispatchFailureDetails, dispatchRefusal } from '../src/domain/dispatch-failure.mjs';

// Public queue/claim integration; controlled executors replace only external effects.
// CI must run these cases. Local product execution is not authorized.
function fixture(t, { claims, now = Date.now } = {}) {
  const effects = [], events = [], terminals = [], controls = new Map();
  let active = 0, peak = 0;
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'fixture', now,
    ...(claims ? { claimExecution: claims, externalBusy: () => claims.busy() } : {}),
    audit: event => events.push(event), onTerminal: job => terminals.push(job.id),
    executeOperation: async operation => {
      effects.push(operation.command); active++; peak = Math.max(peak, active);
      const control = controls.get(operation.command); control.started.resolve();
      try { await control.done.promise; return { failed: false, texts: [operation.command] }; }
      finally { active--; }
    },
  });
  const submit = (command, options) => {
    controls.set(command, { started: Promise.withResolvers(), done: Promise.withResolvers() });
    return queue.submitOperation({ kind: 'command', command }, 'privileged', options);
  };
  const automatic = (command, options) => {
    const job = submit(command, options);
    queue.setDecision(job.id, { decision: 'execute', reasonCode: 'test_server_bypass' });
    return queue.startCommand(job.id);
  };
  t.after(async () => {
    queue.maintenance = true;
    for (const control of controls.values()) control.done.resolve();
    await Promise.allSettled([...queue.jobs.values()].map(job => job.completion).filter(Boolean));
    queue.unsubscribeExecution?.();
  });
  return { queue, submit, automatic, effects, events, terminals,
    started: command => controls.get(command).started.promise,
    release: command => controls.get(command).done.resolve(), get peak() { return peak; } };
}

test('execution queue preserves per-target FIFO and dispatches each automatic request once', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.automatic('first'); await f.started('first');
  const second = f.automatic('second'), third = f.automatic('third');
  assert.equal(second.state, 'queued'); assert.equal(second.approvalMode, 'automatic');
  assert.equal(second.decision.dispatchFailure, undefined);
  assert.deepEqual(f.effects, ['first']);
  const secondDone = f.queue.wait(second.id);
  assert.equal(typeof secondDone.then, 'function', 'queued completion exists before dispatch');
  f.release('first'); await f.queue.wait(first.id); await f.started('second');
  const fourth = f.automatic('fourth'); assert.equal(fourth.state, 'queued');
  assert.deepEqual(f.effects, ['first', 'second']);
  f.release('second'); await secondDone; await f.started('third');
  f.release('third'); await f.queue.wait(third.id); await f.started('fourth');
  f.release('fourth'); await f.queue.wait(fourth.id);
  assert.deepEqual(f.effects, ['first', 'second', 'third', 'fourth']); assert.equal(f.peak, 1);
  assert.deepEqual(f.terminals, [first.id, second.id, third.id, fourth.id]);
});

test('queued automatic approval and queued owner approval are distinct from an undecided owner request', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.automatic('first'); await f.started('first');
  const automatic = f.automatic('automatic'), owner = f.submit('owner'), undecided = f.submit('undecided');
  assert.equal(f.queue.start(owner.id).state, 'queued');
  assert.equal(f.queue.get(owner.id).approvalMode, 'owner');
  assert.equal(f.queue.get(undecided.id).state, 'pending'); assert.equal(f.queue.get(undecided.id).approvalMode, undefined);
  for (const id of [automatic.id, owner.id]) {
    const approved = await f.queue.waitForRequest(id, { until: 'approval' });
    assert.equal(approved.event, 'approved'); assert.equal(approved.job.state, 'queued');
  }
  assert.equal((await f.queue.waitForRequest(undecided.id, { timeoutMs: 1 })).event, 'timeout');
  let completed = false;
  const completion = f.queue.waitForRequest(automatic.id, { until: 'completion' }).then(result => { completed = true; return result; });
  await Promise.resolve(); assert.equal(completed, false);
  f.release('first'); await f.queue.wait(first.id); await f.started('automatic');
  f.release('automatic'); assert.equal((await completion).event, 'completed');
  await f.started('owner'); f.release('owner'); await f.queue.wait(owner.id);
  assert.equal(f.queue.get(undecided.id).state, 'pending'); f.queue.deny(undecided.id);
});

test('denying queued work removes it without effects and lets the next waiter run', { timeout: 5000 }, async t => {
  const claims = createClaims(1, { maxWaiting: 2 }), f = fixture(t, { claims });
  const first = f.automatic('first'); await f.started('first');
  const denied = f.automatic('denied'), next = f.automatic('next');
  const completion = f.queue.wait(denied.id);
  assert.equal(claims.waiting(), 2); assert.equal(f.queue.deny(denied.id).state, 'denied');
  assert.equal((await completion).state, 'denied'); assert.equal(claims.waiting(), 1);
  f.release('first'); await f.queue.wait(first.id); await f.started('next'); f.release('next'); await f.queue.wait(next.id);
  assert.deepEqual(f.effects, ['first', 'next']); assert.equal(claims.waiting(), 0);
  assert.equal(f.terminals.filter(id => id === denied.id).length, 1);
});

test('shared waiting capacity rejects overflow without dropping accepted queued work', { timeout: 5000 }, async t => {
  const claims = createClaims(1, { maxWaiting: 1 }), f = fixture(t, { claims });
  const first = f.automatic('first'); await f.started('first'); const waiting = f.automatic('waiting');
  const overflow = f.submit('overflow'); f.queue.setDecision(overflow.id, { decision: 'execute', reasonCode: 'test_server_bypass' });
  let failure;
  try { f.queue.startCommand(overflow.id); assert.fail('overflow must be refused'); } catch (error) { failure = error; }
  assert.equal(f.queue.rejectAutomaticDispatch(overflow.id, failure), true);
  assert.equal(f.queue.get(overflow.id).state, 'failed');
  assert.equal(f.queue.get(overflow.id).decision.dispatchFailureReason, 'queue_full');
  assert.equal(claims.waiting(), 1);
  f.release('first'); await f.queue.wait(first.id); await f.started('waiting'); f.release('waiting'); await f.queue.wait(waiting.id);
  assert.deepEqual(f.effects, ['first', 'waiting']); assert.equal(claims.waiting(), 0);
});

test('the default per-target queue is bounded at 32 waiting jobs', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.automatic('first'); await f.started('first');
  const waiting = Array.from({ length: 32 }, (_, index) => f.automatic('wait-' + index));
  assert.ok(waiting.every(job => job.state === 'queued'));
  assert.throws(() => f.automatic('overflow'));
  assert.equal(f.queue.waiting.length, 32); assert.deepEqual(f.effects, ['first']);
  f.queue.maintenance = true;
  await Promise.all(waiting.map(job => f.queue.wait(job.id)));
  f.release('first'); await f.queue.wait(first.id);
});

test('queued expiry uses the original deadline and never dispatches expired work', { timeout: 5000 }, async t => {
  let now = 1000;
  const claims = createClaims(1), f = fixture(t, { claims, now: () => now });
  const first = f.automatic('first'); await f.started('first');
  const expired = f.automatic('expired', { expiresAt: now + 20 }), next = f.automatic('next');
  assert.equal(expired.expiresAt, 1020); const done = f.queue.wait(expired.id);
  now = expired.expiresAt; assert.equal(f.queue.get(expired.id).state, 'expired');
  assert.equal((await done).state, 'expired'); assert.equal(claims.waiting(), 1);
  f.release('first'); await f.queue.wait(first.id); await f.started('next'); f.release('next'); await f.queue.wait(next.id);
  assert.deepEqual(f.effects, ['first', 'next']); assert.equal(claims.waiting(), 0);
});

test('maintenance cancels queued work while allowing the active execution to finish', { timeout: 5000 }, async t => {
  const claims = createClaims(1), f = fixture(t, { claims });
  const first = f.automatic('first'); await f.started('first'); const waiting = f.automatic('waiting');
  const done = f.queue.wait(waiting.id); f.queue.maintenance = true;
  const cancelled = await done;
  assert.equal(cancelled.state, 'failed'); assert.equal(cancelled.decision.dispatchFailure, 'not_dispatched');
  assert.equal(cancelled.decision.dispatchFailureReason, 'maintenance'); assert.equal(claims.waiting(), 0);
  assert.equal(f.queue.get(first.id).state, 'running');
  assert.throws(() => f.submit('new'), /Maintenance/);
  f.release('first'); assert.equal((await f.queue.wait(first.id)).state, 'completed');
  f.queue.maintenance = false; f.queue.drainExecution(); assert.deepEqual(f.effects, ['first']);
});

test('queued work revalidates policy and target at dispatch and a revoked head does not block followers', { timeout: 5000 }, async t => {
  for (const [reason, stage] of [['policy_changed', 'policy_guard'], ['target_changed', 'target_guard']]) await t.test(reason, async t => {
    const claims = createClaims(1), f = fixture(t, { claims }); let revoked = false;
    f.queue.beforeCommandStart = job => { if (job.command === 'revoked' && revoked) dispatchRefusal(reason, stage, 'Synthetic binding changed'); };
    const first = f.automatic('first'); await f.started('first');
    const blocked = f.automatic('revoked'), next = f.automatic('next'); revoked = true;
    const done = f.queue.wait(blocked.id); f.release('first'); await f.queue.wait(first.id);
    const refused = await done;
    assert.equal(refused.state, 'failed'); assert.equal(refused.decision.dispatchFailure, 'not_dispatched');
    assert.equal(refused.decision.dispatchFailureReason, reason);
    await f.started('next'); f.release('next'); await f.queue.wait(next.id);
    assert.deepEqual(f.effects, ['first', 'next']); assert.equal(claims.waiting(), 0);
  });
});

test('a read completion releases shared capacity and wakes an automatic job without another submission', { timeout: 5000 }, async t => {
  const claims = createClaims(1), f = fixture(t, { claims }), read = Promise.withResolvers(), entered = Promise.withResolvers();
  const commands = createCommandService({ queue: f.queue, classify: () => ({ class: 'read-only' }), profile: 'fixture', target: 'fixture', readProfile: 'read',
    claimExecution: claims, audit() {}, executeCommand: async () => { entered.resolve(); await read.promise; return { failed: false, texts: ['read'] }; } });
  f.queue.externalBusy = () => commands.reading() || claims.busy();
  t.after(() => read.resolve());
  const running = commands.read('inspect'); await entered.promise;
  const waiting = f.automatic('waiting'); assert.equal(waiting.state, 'queued'); assert.deepEqual(f.effects, []);
  read.resolve(); await running; await f.started('waiting'); f.release('waiting'); await f.queue.wait(waiting.id);
  assert.deepEqual(f.effects, ['waiting']); assert.equal(claims.waiting(), 0);
});

test('a probe claim release wakes queued work after the probe marker clears', { timeout: 5000 }, async t => {
  const claims = createClaims(1), f = fixture(t, { claims }); let probing = true;
  const release = claims(); t.after(release);
  f.queue.externalBusy = () => probing || claims.busy();
  const waiting = f.automatic('waiting'); assert.equal(waiting.state, 'queued');
  probing = false; release(); await f.started('waiting'); f.release('waiting'); await f.queue.wait(waiting.id);
  assert.deepEqual(f.effects, ['waiting']); assert.equal(claims.waiting(), 0);
});

test('another target releasing global capacity wakes the waiting target without serializing free slots', { timeout: 5000 }, async t => {
  const claims = createClaims(2), a = fixture(t, { claims }), b = fixture(t, { claims }), c = fixture(t, { claims });
  const first = a.automatic('a'), second = b.automatic('b'); await Promise.all([a.started('a'), b.started('b')]);
  const waiting = c.automatic('c'); assert.equal(waiting.state, 'queued'); assert.deepEqual(c.effects, []);
  a.release('a'); await a.queue.wait(first.id); await c.started('c');
  assert.equal(b.queue.get(second.id).state, 'running');
  c.release('c'); b.release('b'); await Promise.all([b.queue.wait(second.id), c.queue.wait(waiting.id)]);
  assert.deepEqual(a.effects, ['a']); assert.deepEqual(b.effects, ['b']); assert.deepEqual(c.effects, ['c']); assert.equal(claims.waiting(), 0);
});

test('aborting a completion observer never cancels the accepted queued execution', { timeout: 5000 }, async t => {
  const f = fixture(t), first = f.automatic('first'); await f.started('first');
  const waiting = f.automatic('waiting'), observer = new AbortController();
  const cancelled = assert.rejects(f.queue.waitForRequest(waiting.id, { until: 'completion', signal: observer.signal }));
  observer.abort(); await cancelled;
  assert.equal(f.queue.get(waiting.id).state, 'queued');
  f.release('first'); await f.queue.wait(first.id); await f.started('waiting'); f.release('waiting'); await f.queue.wait(waiting.id);
  assert.deepEqual(f.effects, ['first', 'waiting']);
});

test('queue admission audit and persistence failures keep the request pending and release waiting capacity', { timeout: 5000 }, async t => {
  for (const phase of ['audit', 'persistence']) await t.test(phase, async t => {
    const claims = createClaims(1), f = fixture(t, { claims });
    const first = f.automatic('first'); await f.started('first');
    const refused = f.submit('refused');
    f.queue.setDecision(refused.id, { decision: 'execute', reasonCode: 'test_server_bypass' });
    const originalAudit = f.queue.audit;
    if (phase === 'audit') f.queue.audit = event => {
      if (event.id === refused.id && event.action === 'execution-queued') throw Error('Synthetic admission audit failure');
      originalAudit(event);
    };
    else f.queue.track(refused.id, job => { if (job.state === 'queued') throw Error('Synthetic admission persistence failure'); });
    assert.throws(() => f.queue.startCommand(refused.id), error => {
      assert.deepEqual(dispatchFailureDetails(error), {
        dispatchFailureReason: phase === 'audit' ? 'audit_failed' : 'persistence_failed',
        dispatchFailureStage: phase === 'audit' ? 'start_audit' : 'start_persistence',
      });
      return true;
    });
    const pending = f.queue.get(refused.id);
    assert.equal(pending.state, 'pending'); assert.equal(pending.approvalMode, undefined);
    assert.equal(f.queue.waiting.length, 0); assert.equal(claims.waiting(), 0);
    assert.deepEqual(f.effects, ['first']); assert.equal(f.terminals.includes(refused.id), false);
    f.release('first'); await f.queue.wait(first.id);
    assert.deepEqual(f.effects, ['first']); assert.equal(claims.busy(), false);
    assert.equal(f.queue.get(refused.id).state, 'pending');
  });
});

test('queued dispatch audit and persistence failures settle completion and release resources for the next request', { timeout: 5000 }, async t => {
  for (const phase of ['audit', 'persistence']) await t.test(phase, async t => {
    const claims = createClaims(1), f = fixture(t, { claims });
    const first = f.automatic('first'); await f.started('first');
    const refused = f.automatic('refused'), next = f.automatic('next');
    const completion = f.queue.wait(refused.id);
    const observer = f.queue.waitForRequest(refused.id, { until: 'completion' });
    const originalAudit = f.queue.audit;
    let failures = 0;
    if (phase === 'audit') f.queue.audit = event => {
      if (event.id === refused.id && event.action === 'policy-execution-started') { failures++; throw Error('Synthetic dispatch audit failure'); }
      originalAudit(event);
    };
    else f.queue.track(refused.id, job => {
      if (job.state === 'running') { failures++; throw Error('Synthetic dispatch persistence failure'); }
    });
    f.release('first'); await f.queue.wait(first.id);
    const terminal = await completion, observed = await observer;
    assert.equal(terminal.state, phase === 'audit' ? 'failed' : 'unknown');
    assert.equal(observed.event, terminal.state); assert.equal(observed.job.state, terminal.state);
    assert.equal(f.queue.get(refused.id).state, terminal.state); assert.equal(failures, 1);
    if (phase === 'audit') {
      assert.equal(terminal.decision.dispatchFailure, 'not_dispatched');
      assert.equal(terminal.decision.dispatchFailureReason, 'audit_failed');
      assert.equal(terminal.decision.dispatchFailureStage, 'start_audit');
    }
    await f.started('next');
    assert.deepEqual(f.effects, ['first', 'next']); assert.equal(claims.waiting(), 0);
    f.release('next'); assert.equal((await f.queue.wait(next.id)).state, 'completed');
    assert.equal(claims.busy(), false); assert.equal(f.queue.active, null);
    assert.equal(f.terminals.filter(id => id === refused.id).length, 1);
  });
});

test('expiry observed inside a queued dispatch guard stays terminal once and does not block the next request', { timeout: 5000 }, async t => {
  let now = 1000;
  const claims = createClaims(1), f = fixture(t, { claims, now: () => now });
  const first = f.automatic('first'); await f.started('first');
  const expired = f.automatic('expired', { expiresAt: 2000 }), next = f.automatic('next');
  const completion = f.queue.wait(expired.id), observer = f.queue.waitForRequest(expired.id, { until: 'completion' });
  f.queue.beforeCommandStart = job => {
    if (job.id === expired.id) {
      now = 2000;
      assert.equal(f.queue.get(job.id).state, 'expired');
      dispatchRefusal('private_plan', 'source_plan', 'Synthetic plan expired during guard');
    }
  };
  now = 1999; f.release('first'); await f.queue.wait(first.id);
  const terminal = await completion, observed = await observer;
  assert.equal(terminal.state, 'expired'); assert.equal(observed.event, 'expired');
  assert.deepEqual(terminal, f.queue.get(expired.id));
  assert.equal(f.terminals.filter(id => id === expired.id).length, 1);
  await f.started('next'); f.release('next'); await f.queue.wait(next.id);
  assert.deepEqual(f.effects, ['first', 'next']); assert.equal(claims.waiting(), 0); assert.equal(claims.busy(), false);
  assert.equal(f.queue.get(expired.id).state, 'expired');
});
