import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATION_QUESTION, AUTOMATION_QUESTION_VERSION, COMMAND_SET_QUESTION, validatedRisk } from '../src/domain/command-policy.mjs';
import { SAFETY_QUESTION, validateAssessment } from '../src/domain/safety.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';

const model = 'jev-1.14.0';
const input = { command: 'id -u', target: 'fixture', environment: 'fixture', context: 'Read a public identifier.' };
const assessment = { status: 'assessed', model, label: 'low_risk', confidence: 0.9,
  probabilities: { low_risk: 0.9, high_risk: 0.1 }, inputTokens: 1, outputTokens: 1 };

test('all new Jev questions ask only for safe or risky, and use a new execution contract', () => {
  for (const question of [SAFETY_QUESTION, AUTOMATION_QUESTION, COMMAND_SET_QUESTION]) {
    assert.deepEqual(Object.keys(question.criteria).sort(), ['high_risk', 'low_risk']);
  }
  assert.notEqual(AUTOMATION_QUESTION_VERSION, 'ssh-command-risk-v4');
});

test('binary responses are accepted and a third or malformed score is refused', () => {
  assert.ok(validateAssessment(assessment, model));
  assert.ok(validatedRisk(assessment, model));
  for (const value of [
    { ...assessment, probabilities: { ...assessment.probabilities, uncertain: 0 } },
    { ...assessment, label: 'uncertain' },
    { ...assessment, probabilities: { low_risk: 0.9, high_risk: 0.2 } },
    { ...assessment, label: 'high_risk' },
  ]) {
    assert.equal(validateAssessment(value, model), null);
    assert.equal(validatedRisk(value, model), null);
  }
});

test('the real adapter accepts a binary provider response without leaking the key', async () => {
  let body;
  const assessor = createJevAssessor({ apiKey: 'fixture-key', question: AUTOMATION_QUESTION, inputKind: 'observation',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ model, answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 0.9,
        probabilities: { low_risk: 0.9, high_risk: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal((await assessor.assess(input)).status, 'assessed');
  assert.deepEqual(Object.keys(body.questions.risk.criteria).sort(), ['high_risk', 'low_risk']);
  assert.doesNotMatch(JSON.stringify(body), /fixture-key/);
});
