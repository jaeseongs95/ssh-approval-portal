import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevFixture, fixtureChoice } from './jev-http.fixture.mjs';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { runSafetyEvaluation } from '../scripts/evaluate-safety.mjs';

const input = { command: 'id -u', target: 'fixture-a', environment: 'synthetic Linux', context: 'bounded uid inspection' };
// Fixed independent fixture request; no production encoder or question object imported.
const request = () => ({ model: 'jev-1.13.0', state: { ...input }, questions: { risk: { type: 'choice',
  instructions: 'Classify this synthetic command risk.', criteria: { low_risk: 'Bounded public read', high_risk: 'Mutation or secret exposure', uncertain: 'Unknown effects' },
} } });
const headers = { authorization: 'Bearer fixture-only-token', 'content-type': 'application/json' };
const make = (fixture, options = {}) => createJevAssessor({ apiKey: 'fixture-only-token', fetchImpl: fixture.fetchImpl, ...options });

test('WIRE-01 temporary server independently enforces route, method, bearer, model, state and Choice keys', async () => {
  const fixture = await createJevFixture();
  try {
    const malformed = [
      { method: 'GET', status: 405 }, { path: '/other', status: 404 },
      { headers: { ...headers, authorization: 'Bearer wrong-fixture-token' }, status: 401 },
      { headers: { ...headers, 'content-type': 'text/plain' }, status: 415 }, { raw: '{', status: 400 },
      { change: value => { value.model = 'jev-latest'; }, status: 422 },
      { change: value => { value.state.expected = 'low_risk'; }, status: 422 },
      { change: value => { value.questions.risk.type = 'noul'; }, status: 422 },
      { change: value => { value.questions.extra = value.questions.risk; }, status: 422 },
      { change: value => { value.questions.risk.criteria.needed = 'AGS skill label is not SSH risk'; }, status: 422 },
    ];
    for (const scenario of malformed) {
      const body = request(); scenario.change?.(body);
      const result = await fetch(fixture.origin + (scenario.path || '/v1/systemone'), {
        method: scenario.method || 'POST', headers: scenario.headers || headers,
        ...(scenario.method === 'GET' ? {} : { body: scenario.raw ?? JSON.stringify(body) }),
      });
      assert.equal(result.status, scenario.status); await result.arrayBuffer();
    }
    assert.equal((await make(fixture).assess(input)).status, 'assessed');
    assert.equal(fixture.records.filter(record => record.valid).length, 1);
  } finally { await fixture.close(); }
});

test('WIRE-02 actual evaluation/adapter/HTTP path preserves 20 cases, usage and simulated provenance', async () => {
  const fixture = await createJevFixture();
  try {
    const report = await runSafetyEvaluation({ mode: 'live', apiKey: 'fixture-only-token', fetchImpl: fixture.fetchImpl });
    assert.equal(fixture.records.length, 20); assert.ok(fixture.records.every(record => record.valid));
    assert.deepEqual(report.usage, { inputTokens: 400, outputTokens: 80 });
    assert.equal(report.total, 20); assert.equal(report.assessed, 20); assert.equal(report.correct, 6);
    assert.equal(report.incorrect, 14); assert.equal(report.falseCandidates, 14);
    assert.equal(report.source, 'simulated', 'Injected HTTP fixture must never be reported as real Jev evaluation');
    assert.equal(report.modelQualityStatus, 'NOT_MEASURED'); assert.equal(report.transport, 'injected');
    assert.equal(report.stage5Ready, false); assert.equal(report.protocol.automaticExecutionEnabled, false);
    assert.doesNotMatch(JSON.stringify(report), /fixture-only-token|id -u|bounded uid inspection/);
  } finally { await fixture.close(); }
});

test('WIRE-03 fragmented real HTTP response decodes correctly; unknown keys/models/types refuse then recover', async () => {
  const badModel = fixtureChoice(); badModel.model = 'jev-1.14.0';
  const extra = fixtureChoice(); extra.answers.extra = extra.answers.risk;
  const wrongType = fixtureChoice(); wrongType.answers.risk = { type: 'noul', noul: 1 };
  const good = JSON.stringify(fixtureChoice());
  const fixture = await createJevFixture([{ fragments: [good.slice(0, 12), good.slice(12)] }, { body: badModel }, { body: extra }, { body: wrongType }, {}]);
  try {
    const assessor = make(fixture);
    assert.equal((await assessor.assess(input)).status, 'assessed');
    for (let index = 0; index < 3; index++) assert.deepEqual(await assessor.assess(input), { status: 'unavailable', reason: 'invalid_response' });
    assert.equal((await assessor.assess(input)).status, 'assessed');
    assert.equal(fixture.records.length, 5);
  } finally { await fixture.close(); }
});

test('WIRE-04 real HTTP failures are single-attempt and never disclose error bodies', async () => {
  const fixture = await createJevFixture([401, 429, 500, 529].map(status => ({ status, raw: 'private-error-body' })));
  try {
    const assessor = make(fixture);
    for (let index = 0; index < 4; index++) assert.deepEqual(await assessor.assess(input), { status: 'unavailable', reason: 'http_error' });
    assert.equal(fixture.records.length, 4);
  } finally { await fixture.close(); }
});

test('WIRE-05 actual fetch refuses redirect without contacting the destination', async () => {
  const fixture = await createJevFixture([{ status: 307, headers: { location: '/redirected' }, raw: '' }]);
  try {
    assert.deepEqual(await make(fixture).assess(input), { status: 'unavailable', reason: 'request_failed' });
    assert.equal(fixture.records.length, 1); assert.equal(fixture.records[0].path, '/v1/systemone');
  } finally { await fixture.close(); }
});

test('WIRE-06 real chunked response exceeding 64KiB is unavailable and next request recovers', async () => {
  const fixture = await createJevFixture([{ fragments: ['a'.repeat(32768), 'b'.repeat(32769)] }, {}]);
  try {
    const assessor = make(fixture);
    assert.deepEqual(await assessor.assess(input), { status: 'unavailable', reason: 'response_too_large' });
    assert.equal((await assessor.assess(input)).status, 'assessed'); assert.equal(fixture.records.length, 2);
  } finally { await fixture.close(); }
});

for (const hold of ['headers', 'body']) test(`WIRE-07 ${hold} timeout closes real response and permits recovery without queued duplicate`, async () => {
  const fixture = await createJevFixture([{ hold }, {}]);
  try {
    const assessor = make(fixture, { timeoutMs: 500 });
    const first = assessor.assess(input);
    assert.deepEqual(await assessor.assess(input), { status: 'unavailable', reason: 'busy' });
    assert.deepEqual(await first, { status: 'unavailable', reason: 'timeout' });
    await fixture.waitForHeldClose(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.closedHeldResponses, 1); assert.equal(fixture.records.length, 1);
    assert.equal((await assessor.assess(input)).status, 'assessed'); assert.equal(fixture.records.length, 2);
  } finally { await fixture.close(); }
});
