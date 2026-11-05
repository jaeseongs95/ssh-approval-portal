import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { AUTOMATION_QUESTION_VERSION } from '../src/domain/command-policy.mjs';

// 1.7 baseline: test/legacy-17/request-safety-http.test.mjs.17.
// assess-request-risk and its caller disclosure flag were removed. Owner-recorded policy now grants
// disclosure; submit triggers bound evaluation and observe returns operation status without reassessment.
// Preserve authenticated access, no disclosure without consent, assessment-disabled behavior,
// idempotency and the rule that a low-risk assessment never grants owner approval.
// HTTP integration; product execution/proof are remote-only. Local checks are syntax and diff only.
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const assessment = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0 }, inputTokens: 7, outputTokens: 1 };

async function saveDisclosure(application, externalDisclosure) {
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${application.adminHttp.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer fixture-admin', ...(body === undefined ? {} : { Origin: 'https://example.test', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const current = await api('/api/command-policy'), binding = current.bindings.find(item => item.targetId === 'default');
  assert.ok(binding);
  const proposal = { expectedRevision: current.revision, policy: { targets: [{ targetId: binding.targetId,
    targetRevision: binding.targetRevision, profile: binding.profile, commands: [], deniedCommands: [],
    externalDisclosure, modelExecution: false, automaticSudo: true, fallback: null, thresholds: {} }] } };
  const review = await api('/api/command-policy/review', proposal);
  await api('/api/command-policy', { ...proposal, reviewToken: review.reviewToken, acknowledged: true });
  return { target: binding.targetId, expectedTargetRevision: binding.targetRevision };
}

async function observePending(client, id) {
  let operation;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await client.callTool({ name: 'observe', arguments: { id, waitMs: 1000, includeOutput: true } });
    assert.equal(response.structuredContent.ok, true);
    operation = response.structuredContent.data;
    if (!['accepted', 'evaluating'].includes(operation.state)) break;
  }
  assert.equal(operation.state, 'pending');
  assert.equal(operation.outputPage, null);
  return operation;
}

test('authenticated MCP evaluates only with owner disclosure policy and observation leaves approval pending', async () => {
  for (const enabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'ssh-jev-http-')); let calls = 0, client;
    const application = await createApplication({
      registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }), executeCommand: () => assert.fail('unexpected SSH execution'),
      policyRiskAssessor: { model: assessment.model, assess: async () => assessment },
      riskEvaluators: enabled ? { jev: { model: assessment.model, questionVersion: AUTOMATION_QUESTION_VERSION,
        assess: async input => { calls++; assert.equal(input.target, 'default'); assert.equal(input.command, 'sudo id'); return assessment; } } } : {},
      audit: () => {}, transferRoot: root, uiHtml: '<html>fixture</html>',
      env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test',
        BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_JEV_ENABLED: String(enabled), BRIDGE_COMMAND_AUTOMATION: 'true' },
    });
    try {
      await listen(application.mcpHttp); await listen(application.adminHttp);
      const url = new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`);
      assert.equal((await fetch(url, { method: 'POST' })).status, 401);
      client = new Client({ name: 'synthetic-jev-host', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
      assert.ok((await client.listTools()).tools.every(tool => tool.name !== 'assess-request-risk'));
      const bound = await saveDisclosure(application, false);
      const forged = await client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: 'http-risk-forged-consent',
        command: 'sudo id', externalDisclosureApproved: true, ...bound } });
      assert.equal(forged.isError, true, 'caller fields cannot grant disclosure authority');
      assert.equal(calls, 0);
      const undisclosed = await client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: 'http-risk-no-owner-consent',
        command: 'sudo id', context: 'Synthetic unprivileged fixture', ...bound } });
      assert.equal(undisclosed.structuredContent.ok, true);
      await observePending(client, undisclosed.structuredContent.data.id);
      assert.equal(application.queue.get(undisclosed.structuredContent.data.id).decision.reasonCode, 'disclosure_not_enabled');
      assert.equal(calls, 0);
      await saveDisclosure(application, true);
      const args = { kind: 'command', operationKey: 'http-risk-owner-consent', command: 'sudo id', context: 'Synthetic unprivileged fixture', ...bound };
      const submitted = await client.callTool({ name: 'submit', arguments: args });
      assert.equal(submitted.structuredContent.ok, true);
      const job = await observePending(client, submitted.structuredContent.data.id);
      assert.equal(job.targetId, bound.target); assert.equal(job.targetRevision, bound.expectedTargetRevision);
      const decision = application.queue.get(job.id).decision;
      assert.equal(decision.decision, 'review');
      assert.equal(decision.reasonCode, enabled ? 'observation_only' : 'evaluation_unavailable');
      assert.equal(decision.assessment?.label, enabled ? 'low_risk' : undefined);
      const replay = await client.callTool({ name: 'submit', arguments: args });
      assert.equal(replay.structuredContent.ok, true); assert.equal(replay.structuredContent.data.id, job.id);
      await observePending(client, job.id);
      assert.equal(calls, enabled ? 1 : 0);
      assert.equal(application.queue.get(job.id).state, 'pending');
    } finally { await client?.close(); await application.close(); await rm(root, { recursive: true }); }
  }
});
