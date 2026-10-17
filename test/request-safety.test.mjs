import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { createRequestSafety } from '../src/application/request-safety.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';

const result = { status: 'assessed', model: 'jev-1.13.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0, uncertain: 0 }, inputTokens: 7, outputTokens: 1 };
const queue = () => new ApprovalQueue({ classify: () => ({ class: 'privileged' }), profile: 'fixture-write',
  target: 'secret-user@private-host:22', identity: { targetId: 'test', targetRevision: 'rev-1', targetDisplayName: '시험' },
  executeOperation: () => assert.fail('Risk assessment must not execute SSH') });

test('request assessment freezes server identity and shares an in-flight result across callers', async () => {
  const q = queue(), job = q.submit('sudo id');
  let complete, count = 0, transmitted;
  const service = createRequestSafety({ queue: q, assessor: { assess(input) {
    count++; transmitted = input; return new Promise(resolve => { complete = resolve; });
  } } });
  const first = service.assess(job.id, 'first synthetic context');
  const second = service.assess(job.id, 'later context');
  await Promise.resolve();
  assert.equal(count, 1);
  assert.deepEqual({ ...transmitted, context: undefined }, { command: 'sudo id', target: 'test', environment: '시험', context: undefined });
  const details = JSON.parse(transmitted.context);
  assert.equal(details.callerSituation, 'first synthetic context');
  assert.equal(details.serverFacts.sshTarget, 'secret-user@private-host:22');
  assert.equal(details.serverFacts.profile, 'fixture-write');
  complete({ ...result, injectedSecret: 'must-not-escape' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.notEqual(a, b);
  assert.equal(a.subject, q.subject(job.id));
  assert.equal(a.targetId, 'test'); assert.equal(a.targetRevision, 'rev-1');
  assert.equal(a.automaticExecutionEnabled, false);
  assert.equal(a.assessment.injectedSecret, undefined);
  assert.equal(q.get(job.id).state, 'pending');
  await service.assess(job.id); assert.equal(count, 1);
});

test('provider failure is sanitized, cached and never retried', async () => {
  const q = queue(), job = q.submit('sudo id'); let count = 0;
  const service = createRequestSafety({ queue: q, assessor: { assess() { count++; throw Error('secret provider diagnostic'); } } });
  const a = await service.assess(job.id), b = await service.assess(job.id);
  assert.equal(a.assessment.reason, 'request_failed'); assert.deepEqual(a, b); assert.equal(count, 1);
  assert.ok(!JSON.stringify(a).includes('secret provider'));
  assert.equal(q.get(job.id).state, 'pending');
});

test('process call budget bounds distinct requests and cached reads consume no calls', async () => {
  const q = queue(), a = q.submit('sudo id'), b = q.submit('sudo pwd'); let count = 0;
  const service = createRequestSafety({ queue: q, maxCalls: 1, assessor: { assess: async () => { count++; return result; } } });
  await service.assess(a.id); await service.assess(a.id);
  assert.equal((await service.assess(b.id)).assessment.reason, 'budget_exhausted'); assert.equal(count, 1);
});

test('disabled observer, unknown ID, file jobs and denied requests never call the assessor', async () => {
  const q = queue(), job = q.submit('sudo id');
  assert.equal((await createRequestSafety({ queue: q }).assess(job.id)).assessment.reason, 'not_configured');
  const service = createRequestSafety({ queue: q, assessor: { assess() { assert.fail('unexpected disclosure'); } } });
  await assert.rejects(service.assess('unknown'), /command request/);
  const file = q.submitOperation({ kind: 'download', remotePath: '/synthetic', elevate: true });
  await assert.rejects(service.assess(file.id), /command request/);
  q.deny(job.id); await assert.rejects(service.assess(job.id), /pending/);
});

test('Jev opt-in and bounded call limit are strict configuration values', () => {
  const env = { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test' };
  assert.equal(parseSettings(env).jevEnabled, false);
  assert.equal(parseSettings(env).jevMaxCalls, 100);
  assert.equal(parseSettings({ ...env, BRIDGE_JEV_ENABLED: 'true', BRIDGE_JEV_MAX_CALLS: '3' }).jevEnabled, true);
  for (const value of ['TRUE', '1', 'yes']) assert.throws(() => parseSettings({ ...env, BRIDGE_JEV_ENABLED: value }));
  for (const value of ['0', '1.5', '1e2', '10001', '']) assert.throws(() => parseSettings({ ...env, BRIDGE_JEV_MAX_CALLS: value }));
});
