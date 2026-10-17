import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandPolicyReview } from '../src/application/command-policy-review.mjs';

const rule = () => ({ targetId: 'default', targetRevision: 'a'.repeat(64), profile: 'aws-local', commands: ['sudo', 'rm'],
  deniedCommands: [], externalDisclosure: true, modelExecution: false, fallback: null, thresholds: {} });
const low = { status: 'assessed', model: 'jev-1.13.0', label: 'low_risk', confidence: 1, probabilities: { low_risk: 1, high_risk: 0, uncertain: 0 } };
function fixture(options = {}) {
  let current = { revision: 0, targets: [] }, time = 0, serial = 0;
  const calls = [], events = [], budget = { used: 0 };
  const state = { policy: () => structuredClone(current), setPolicy(policy, expected) { assert.equal(current.revision, expected); return current = { ...structuredClone(policy), revision: expected + 1 }; } };
  const review = createCommandPolicyReview({ state, validateTargets(value) { for (const target of value.targets) if (target.targetRevision !== 'a'.repeat(64)) throw Error('Stale target'); },
    evaluator: { async assess(input) { calls.push(input); return low; } }, audit: event => events.push(event), nonce: () => (++serial).toString(16).padStart(48, '0'), maxCalls: 2, budget, now: () => time, ...options });
  return { review, state, calls, events, budget, advance: () => { time += 300001; } };
}

test('registration risk feedback precedes persistence and carries proposals rather than user approval', async () => {
  const f = fixture(), policy = { targets: [rule()] };
  const feedback = await f.review.review(policy, 0);
  assert.equal(f.state.policy().revision, 0); assert.deepEqual(f.state.policy().targets, []);
  assert.equal(f.events[0].id, feedback.reviewId); assert.notEqual(f.events[0].id, feedback.reviewToken);
  assert.equal(feedback.feedback[0].level, 'high_risk'); assert.match(feedback.feedback[0].warning, /rm/);
  assert.deepEqual(f.calls[0].proposedCommands, ['sudo', 'rm']); assert.equal(f.calls[0].userApproval, undefined);
  assert.doesNotMatch(JSON.stringify(f.calls[0]), /thresholds|explicit/);
  const details = JSON.parse(f.calls[0].context);
  assert.equal(details.serverFacts.targetRevision, rule().targetRevision); assert.equal(details.serverFacts.profile, 'aws-local');
  assert.match(details.callerSituation, /not yet approved/);
  assert.equal(f.review.set(policy, 0, feedback.reviewToken, true).revision, 1);
});

test('concurrent reviews and unconsumed confirmation storage have fixed bounds', async () => {
  let release;
  const waiting = fixture({ evaluator: { assess: () => new Promise(resolve => { release = resolve; }) } });
  const policy = { targets: [rule()] }, first = waiting.review.review(policy, 0);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(waiting.review.review(policy, 0), /busy/); release(low); await first;
  const bounded = fixture({ evaluator: undefined });
  for (let i = 0; i < 16; i++) await bounded.review.review(policy, 0);
  await assert.rejects(bounded.review.review(policy, 0), /busy/);
  bounded.advance(); assert.ok((await bounded.review.review(policy, 0)).reviewToken);
});

test('missing OK, forged token, altered proposal and stale revision cannot register; tokens are single use', async () => {
  const f = fixture(), policy = { targets: [rule()] }, feedback = await f.review.review(policy, 0);
  for (const [value, revision, token, ok] of [[policy, 0, undefined, true], [policy, 0, 'fake', true], [policy, 0, feedback.reviewToken, false],
    [{ targets: [{ ...rule(), commands: ['ls'] }] }, 0, feedback.reviewToken, true], [policy, 1, feedback.reviewToken, true]]) {
    assert.throws(() => f.review.set(value, revision, token, ok)); assert.equal(f.state.policy().revision, 0);
  }
  f.review.set(policy, 0, feedback.reviewToken, true);
  assert.throws(() => f.review.set(policy, 1, feedback.reviewToken, true));
});

test('expiry and changed bindings invalidate confirmation and invalid candidates make no paid calls', async () => {
  const f = fixture(), policy = { targets: [rule()] }, feedback = await f.review.review(policy, 0);
  f.advance(); assert.throws(() => f.review.set(policy, 0, feedback.reviewToken, true));
  const calls = f.calls.length;
  await assert.rejects(f.review.review({ targets: [{ ...rule(), targetRevision: 'b'.repeat(64) }] }, 0));
  await assert.rejects(f.review.review({ targets: [{ ...rule(), commands: ['ls -la'] }] }, 0));
  assert.equal(f.calls.length, calls);
});

test('a policy change during model feedback prevents issuing a usable review', async () => {
  let release;
  const f = fixture({ evaluator: { assess: () => new Promise(resolve => { release = resolve; }) } });
  const pending = f.review.review({ targets: [rule()] }, 0);
  await new Promise(resolve => setImmediate(resolve));
  f.state.setPolicy({ targets: [] }, 0); release(low);
  await assert.rejects(pending, /revision/); assert.equal(f.state.policy().targets.length, 0);
});

test('missing disclosure or evaluator and exhausted budget return explicit uncertainty; sudo alone is not a high-risk verdict', async () => {
  const f = fixture({ evaluator: undefined });
  const policy = { targets: [{ ...rule(), commands: ['sudo'], externalDisclosure: false }] };
  const review = await f.review.review(policy, 0);
  assert.equal(review.feedback[0].level, 'uncertain'); assert.equal(review.feedback[0].assessment, null);
  assert.equal(review.feedback[0].reason, 'external_disclosure_not_enabled'); assert.equal(f.budget.used, 0);
  const missing = await f.review.review({ targets: [{ ...policy.targets[0], externalDisclosure: true }] }, 0);
  assert.equal(missing.feedback[0].reason, 'not_configured');
  const exhausted = fixture({ maxCalls: 0 });
  assert.equal((await exhausted.review.review({ targets: [rule()] }, 0)).feedback[0].reason, 'budget_exhausted');
  assert.equal(exhausted.calls.length, 0);
});

test('failed assessment still requires an explicit informed OK; failed audit cannot commit', async () => {
  const policy = { targets: [rule()] };
  const f = fixture({ evaluator: { async assess() { throw Error('private-provider-error'); } } });
  const feedback = await f.review.review(policy, 0);
  assert.equal(feedback.feedback[0].reason, 'evaluation_unavailable'); assert.doesNotMatch(JSON.stringify(feedback), /private-provider-error/);
  assert.throws(() => f.review.set(policy, 0, feedback.reviewToken, undefined));
  f.review.set(policy, 0, feedback.reviewToken, true); assert.equal(f.state.policy().revision, 1);
  const broken = fixture({ audit: event => { if (event.action === 'command-policy-change-requested') throw Error('audit failed'); } });
  const checked = await broken.review.review(policy, 0);
  assert.throws(() => broken.review.set(policy, 0, checked.reviewToken, true), /audit failed/); assert.equal(broken.state.policy().revision, 0);
});
