import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { createModelCatalog } from '../src/application/model-catalog.mjs';

const input = { command: 'pwd', target: 'synthetic', environment: 'synthetic only', context: 'Compatibility fixture only' };
const response = model => new Response(JSON.stringify({ model, answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1, probabilities: { low_risk: 1, high_risk: 0 } } }, usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
test('selected pinned version reaches the API and old saved versions remain exact; aliases cannot move authority', async () => {
  const seen = [];
  const assessor = createJevAssessor({ apiKey: 'synthetic', questionVersion: 'ssh-command-risk-v5', fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); seen.push(body.model); return response(body.model); } });
  for (const model of ['jev-1.13.0', 'jev-1.14.0']) { const selected = assessor.forModel(model); assert.equal(selected.questionVersion, 'ssh-command-risk-v5'); assert.equal((await selected.assess(input)).model, model); }
  assert.deepEqual(seen, ['jev-1.13.0', 'jev-1.14.0']); assert.equal(assessor.model, 'jev-1.14.0'); assert.equal(assessor.forModel('jev-latest'), undefined);
  const wrong = createJevAssessor({ apiKey: 'synthetic', fetchImpl: async () => response('jev-1.13.0') });
  assert.equal((await wrong.assess(input)).reason, 'invalid_response');
});
test('switching model versions cannot bypass the shared outstanding-call limit', async () => {
  let release, count = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic', fetchImpl: async () => { count++; await new Promise(resolve => { release = resolve; }); return response('jev-1.14.0'); } });
  const pending = assessor.assess(input); assert.equal((await assessor.forModel('jev-1.13.0').assess(input)).reason, 'busy'); release(); await pending; assert.equal(count, 1);
});
test('catalog reads coalesce, refresh daily, keep failures for an hour, and never evaluate commands', async () => {
  let clock = 100, calls = 0, fail = false, complete;
  const catalog = createModelCatalog({ configured: true, now: () => clock, providers: { luna: { model: 'host-luna' } }, jev: { listModels() { calls++; if (fail) throw Error('private provider error'); return new Promise(resolve => { complete = resolve; }); } } });
  const a = catalog.get(), b = catalog.get(); await Promise.resolve(); assert.equal(calls, 1); complete(['jev-1.16.0', 'jev-latest']);
  const first = await a, other = await b; assert.deepEqual(first, other); assert.ok(first.jev.models.includes('jev-1.16.0')); assert.ok(!first.jev.models.includes('jev-latest')); assert.equal(first.jev.defaultModel, 'jev-1.14.0');
  assert.deepEqual(first.luna.models, ['host-luna']); assert.equal(first.sonnet.configured, false);
  first.jev.models.length = 0; assert.ok((await catalog.get()).jev.models.length); assert.equal(calls, 1);
  clock += 86400001; fail = true; assert.equal((await catalog.get()).status, 'unavailable'); await catalog.get(); assert.equal(calls, 2);
  clock += 3600001; const retry = catalog.get(); await retry; assert.equal(calls, 3);
});
test('provider model metadata uses the fixed account endpoint and excludes aliases and unknown fields', async () => {
  let calls = 0;
  const assessor = createJevAssessor({ apiKey: 'synthetic', fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://api.typesafe.ai/v1/models'); assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ models: [{ name: 'jev-1.14.0', secret: 'not returned' }, { name: 'jev-latest' }] }), { headers: { 'content-type': 'application/json' } }); } });
  assert.deepEqual(await assessor.listModels(), ['jev-1.14.0']); assert.equal(calls, 1);
});
