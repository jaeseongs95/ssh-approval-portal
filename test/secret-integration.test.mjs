import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { JEV_ENDPOINT } from '../src/adapters/safety/jev.mjs';

test('MCP risk observation resolves injected secrets internally, preserves env compatibility and fails closed', async () => {
  const originalFetch = globalThis.fetch;
  for (const mode of ['reference', 'environment', 'missing', 'disabled']) {
    let reads = 0, calls = 0, client, application; const audit = [];
    const marker = 'synthetic-credential-must-not-escape', root = await mkdtemp(join(tmpdir(), 'ssh-secret-integration-'));
    globalThis.fetch = async (url, options) => {
      if (String(url) !== JEV_ENDPOINT) return originalFetch(url, options);
      calls++; assert.equal(options.headers.Authorization, 'Bearer ' + marker);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { risk: { type: 'choice', choice: 'low_risk', confidence: 1,
        probabilities: { low_risk: 1, high_risk: 0, uncertain: 0 } } }, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      application = await createApplication({
        registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
        classify: () => ({ class: 'privileged' }), executeCommand: () => assert.fail('unexpected SSH execution'),
        audit: event => audit.push(event), transferRoot: root, uiHtml: '<html>fixture</html>',
        secretResolver: { resolve: async ref => { reads++; assert.equal(ref, 'secret://another-vendor/model-key'); if (mode === 'missing') throw Error(marker); return marker; } },
        env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test',
          BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_JEV_ENABLED: String(mode !== 'disabled'), BRIDGE_JEV_KEY_REF: 'secret://another-vendor/model-key',
          ...(mode === 'environment' ? { JEV_API_KEY: marker } : {}) },
      });
      await new Promise(resolve => application.mcpHttp.listen(0, '127.0.0.1', resolve));
      client = new Client({ name: 'synthetic-secret-host', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture-mcp' } } }));
      assert.ok((await client.listTools()).tools.every(tool => !/secret/.test(tool.name)));
      const job = (await client.callTool({ name: 'run-command', arguments: { command: 'sudo id' } })).structuredContent;
      const result = (await client.callTool({ name: 'assess-request-risk', arguments: { id: job.id, externalDisclosureApproved: true } })).structuredContent;
      assert.equal(result.assessment.status, ['reference', 'environment'].includes(mode) ? 'assessed' : 'unavailable');
      assert.equal(reads, ['reference', 'missing'].includes(mode) ? 1 : 0);
      assert.equal(calls, ['reference', 'environment'].includes(mode) ? 1 : 0);
      assert.equal(application.queue.get(job.id).state, 'pending');
      assert.doesNotMatch(JSON.stringify({ result, audit }), new RegExp(marker));
    } finally { await client?.close(); await application?.close(); globalThis.fetch = originalFetch; await rm(root, { recursive: true }); }
  }
});
