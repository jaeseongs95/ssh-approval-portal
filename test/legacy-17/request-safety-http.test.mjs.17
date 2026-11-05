import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const assessment = { status: 'assessed', model: 'jev-1.14.0', label: 'low_risk', confidence: 1,
  probabilities: { low_risk: 1, high_risk: 0 }, inputTokens: 7, outputTokens: 1 };

test('authenticated MCP observes a bound request only after explicit disclosure and leaves approval pending', async () => {
  for (const enabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'ssh-jev-http-')); let calls = 0, client;
    const application = await createApplication({
      registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: () => ({ class: 'privileged' }), executeCommand: () => assert.fail('unexpected SSH execution'),
      riskAssessor: { assess: async () => { calls++; return assessment; } }, audit: () => {}, transferRoot: root, uiHtml: '<html>fixture</html>',
      env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test',
        BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_JEV_ENABLED: String(enabled) },
    });
    try {
      await listen(application.mcpHttp);
      const url = new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`);
      assert.equal((await fetch(url, { method: 'POST' })).status, 401);
      client = new Client({ name: 'synthetic-jev-host', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
      const job = (await client.callTool({ name: 'run-command', arguments: { command: 'sudo id' } })).structuredContent;
      for (const extra of [{}, { externalDisclosureApproved: false }]) {
        assert.equal((await client.callTool({ name: 'assess-request-risk', arguments: { id: job.id, ...extra } })).isError, true);
      }
      assert.equal(calls, 0);
      const args = { id: job.id, externalDisclosureApproved: true, context: 'Synthetic unprivileged fixture' };
      const risk = (await client.callTool({ name: 'assess-request-risk', arguments: args })).structuredContent;
      assert.equal(risk.id, job.id); assert.equal(risk.subject, application.queue.subject(job.id));
      assert.equal(risk.automaticExecutionEnabled, false);
      assert.equal(risk.assessment.status, enabled ? 'assessed' : 'unavailable');
      await client.callTool({ name: 'assess-request-risk', arguments: args });
      assert.equal(calls, enabled ? 1 : 0);
      assert.equal((await client.callTool({ name: 'get-request-status', arguments: { id: job.id } })).structuredContent.state, 'pending');
    } finally { await client?.close(); await application.close(); await rm(root, { recursive: true }); }
  }
});
