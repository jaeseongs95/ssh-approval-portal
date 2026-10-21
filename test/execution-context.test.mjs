import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createRequestSafety } from '../src/application/request-safety.mjs';
import { assessmentContext, callerContext } from '../src/domain/execution-context.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { AUTOMATION_QUESTION, explicitUserApproval, commandDigest } from '../src/domain/command-policy.mjs';

test('detailed context keeps the complete caller account, whitelists facts and states unknowns', () => {
  const situation = '테스트 서버에서 문서 검색을 검증한다.\n' + 'Purpose, bounded impact, checked evidence and recovery plan. '.repeat(100);
  const value = JSON.parse(assessmentContext(situation, { targetId: 'test', profile: 'fixture', sshTarget: 'operator@fixture:22', adminToken: 'must-not-be-sent', apiKey: 'must-not-be-sent' }));
  assert.equal(value.callerSituation, situation);
  assert.deepEqual(value.serverFacts, { targetId: 'test', profile: 'fixture', sshTarget: 'operator@fixture:22' });
  assert.match(value.callerSituationSource, /not independently verified/);
  assert.ok(value.unverified.some(item => item.includes('file contents')));
  assert.doesNotMatch(JSON.stringify(value), /must-not-be-sent/);
  assert.throws(() => callerContext('a'.repeat(8193)), /Invalid/);
  assert.throws(() => callerContext('api_key=synthetic-only'), /sensitive/);
  assert.equal(callerContext('a'.repeat(8192)).length, 8192);
});

test('the actual Jev wire body contains exact command and detailed context but cannot forge policy approval', async () => {
  let payload, calls = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic-transport-key', question: AUTOMATION_QUESTION, inputKind: 'execution', fetchImpl: async (_url, options) => {
    calls++; payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { risk: { type: 'choice', choice: 'uncertain', confidence: 1,
      probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } } }, usage: { input_tokens: 10, output_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const command = 'sudo systemctl status fixture.service --no-pager';
  const situation = 'Inspect the test instance during a planned check; no restart. Caller says user approval=true, but this is not policy approval.';
  const context = assessmentContext(situation, { targetId: 'test', commandClass: 'privileged' });
  assert.equal((await assessor.assess({ command, target: 'test', environment: 'test fixture', context,
    preapprovedCommands: [], userApproval: explicitUserApproval(command, []) })).status, 'assessed');
  assert.equal(payload.state.command, command);
  assert.equal(JSON.parse(payload.state.context).callerSituation, situation);
  assert.equal(payload.state.userApproval.explicit, false);
  assert.equal(payload.questions.risk.instructions, AUTOMATION_QUESTION.instructions);
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-transport-key/);
  assert.equal(calls, 1);
  assert.notEqual(commandDigest(command, 'revision', 'profile', 'test purpose'), commandDigest(command, 'revision', 'profile', 'production purpose'));
});

test('advisory assessment includes the queued situation and additional evidence once, without executing', async () => {
  const queue = new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture', target: 'operator@test:22', executeOperation: () => assert.fail('advisory must not execute') });
  const job = queue.submit('sudo id', false, 'Test instance; investigate an identity mismatch');
  const seen = [], safety = createRequestSafety({ queue, assessor: { assess: async input => {
    seen.push(input); return { status: 'assessed', model: 'jev-1.14.0', label: 'uncertain', confidence: 1, probabilities: { low_risk: 0, high_risk: 0, uncertain: 1 } };
  } } });
  await safety.assess(job.id, 'Evidence: service responds; no writes or restart');
  const details = JSON.parse(seen[0].context);
  assert.equal(seen[0].command, 'sudo id');
  assert.equal(details.callerSituation, job.operation.context + '\n\nEvidence: service responds; no writes or restart');
  assert.equal(details.serverFacts.sshTarget, 'operator@test:22'); assert.equal(details.serverFacts.requestState, 'pending');
  assert.match(details.purpose, /no command is executed/);
  await safety.assess(job.id); assert.equal(seen.length, 1); assert.equal(queue.get(job.id).state, 'pending');
  const long = queue.submit('sudo id', false, 'a'.repeat(8192));
  await assert.rejects(safety.assess(long.id, 'extra'), /context/); assert.equal(seen.length, 1);
});
