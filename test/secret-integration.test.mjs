import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { JEV_ENDPOINT } from '../src/adapters/safety/jev.mjs';

// 1.7 baseline: test/legacy-17/secret-integration.test.mjs.17.
// Removed assess-request-risk maps to owner-configured disclosure plus submit/observe. Secret
// resolution and failure-closed checks now exercise the execution evaluator with modelExecution=false.
// The private recorded decision is the assessment oracle; public status and audit must not leak keys.
// HTTP integration; local product execution/proof are NOT_RUN under the remote-only test policy.
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

test('MCP evaluation resolves injected secrets internally, preserves env compatibility and fails closed', async () => {
  const originalFetch = globalThis.fetch;
  for (const mode of ['reference', 'environment', 'missing', 'disabled']) {
    let reads = 0, calls = 0, client, application; const audit = [];
    const marker = 'synthetic-credential-must-not-escape', root = await mkdtemp(join(tmpdir(), 'ssh-secret-integration-'));
    globalThis.fetch = async (url, options) => {
      if (String(url) !== JEV_ENDPOINT) return originalFetch(url, options);
      calls++; assert.equal(options.headers.Authorization, 'Bearer ' + marker);
      return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1,
        probabilities: { low_risk: 1, high_risk: 0 } } }, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      application = await createApplication({
        registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
        classify: () => ({ class: 'privileged' }), executeCommand: () => assert.fail('unexpected SSH execution'),
        policyRiskAssessor: { model: assessment.model, assess: async () => assessment },
        audit: event => audit.push(event), transferRoot: root, uiHtml: '<html>fixture</html>',
        secretResolver: { resolve: async ref => { reads++; assert.equal(ref, 'secret://another-vendor/model-key'); if (mode === 'missing') throw Error(marker); return marker; } },
        env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test',
          BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_COMMAND_AUTOMATION: 'true', BRIDGE_JEV_ENABLED: String(mode !== 'disabled'), BRIDGE_JEV_KEY_REF: 'secret://another-vendor/model-key',
          ...(mode === 'environment' ? { JEV_API_KEY: marker } : {}) },
      });
      await new Promise(resolve => application.mcpHttp.listen(0, '127.0.0.1', resolve));
      await new Promise(resolve => application.adminHttp.listen(0, '127.0.0.1', resolve));
      client = new Client({ name: 'synthetic-secret-host', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
      assert.ok((await client.listTools()).tools.every(tool => !/secret/.test(tool.name)));
      const binding = await saveDisclosure(application, true);
      const submitted = await client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: `secret-evaluation-${mode}`,
        command: 'sudo id', context: 'Synthetic secret-resolution fixture', ...binding } });
      assert.equal(submitted.structuredContent.ok, true);
      const result = await observePending(client, submitted.structuredContent.data.id);
      const decision = application.queue.get(result.id).decision;
      assert.equal(decision.decision, 'review');
      assert.equal(decision.reasonCode, ['reference', 'environment'].includes(mode) ? 'observation_only' : 'evaluation_unavailable');
      assert.equal(decision.assessment?.label, ['reference', 'environment'].includes(mode) ? 'low_risk' : undefined);
      assert.equal(reads, ['reference', 'missing'].includes(mode) ? 1 : 0);
      assert.equal(calls, ['reference', 'environment'].includes(mode) ? 1 : 0);
      assert.equal(application.queue.get(result.id).state, 'pending');
      assert.doesNotMatch(JSON.stringify({ result, decision, audit }), new RegExp(marker));
    } finally { await client?.close(); await application?.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true }); }
  }
});
