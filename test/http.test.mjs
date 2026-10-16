import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = { host: '127.0.0.1', port: 22, user: 'mcpops' };
test('MCP transport, hidden capability, ticket checks, probe-only gate and web origin coexist', async () => {
  for (const enabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'ssh-http-')); const calls = [];
    const application = await createApplication({ registry: { getProfile: name => ({ ...profile, readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
      classify: command => ({ class: command === 'id -un' ? 'read-only' : 'privileged' }),
      executeCommand: async (_, command) => { calls.push(command); return { content: [{ type: 'text', text: 'mcpops' }] }; }, audit: () => {}, transferRoot: root,
      env: { BRIDGE_MCP_TOKEN: 'test-mcp', BRIDGE_ADMIN_TOKEN: 'test-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64), BRIDGE_UI_ENABLED: String(enabled), BRIDGE_DISPLAY_NAME: '시험 <bridge> & $&', BRIDGE_TARGET_DISPLAY_NAME: '운영 \"target\"' }, uiHtml: '<html>test</html>' });
    let client;
    try {
      await listen(application.mcpHttp); await listen(application.adminHttp);
      const url = new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`);
      assert.equal((await fetch(url, { method: 'POST' })).status, 401);
      client = new Client({ name: 'test-host', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-mcp' } } }));
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.find(x => x.name === 'ui-decide-request')._meta.ui.visibility, ['app']);
      const probe = await client.callTool({ name: 'show-ui-probe', arguments: {} });
      assert.ok(probe._meta.sshApproval.privateMarker); assert.ok(!JSON.stringify(probe.content).includes('PRIVATE'));
      for (const name of ['read-command', 'run-command']) {
        const read = await client.callTool({ name, arguments: { command: 'id -un' } });
        assert.ok(!read.isError); assert.equal(read.content[0].text, 'mcpops');
        assert.equal(read.structuredContent.state, 'completed');
      }
      calls.length = 0;
      const job = (await client.callTool({ name: 'run-command', arguments: { command: 'sudo -n -l' } })).structuredContent;
      assert.equal(calls.length, 0);
      const card = await client.callTool({ name: 'show-approval', arguments: { id: job.id } });
      assert.ok(!JSON.stringify(card.structuredContent).includes('Ticket'));
      assert.equal(card._meta.sshApproval.bridgeDisplayName, '시험 <bridge> & $&');
      assert.equal(card._meta.sshApproval.targetDisplayName, '운영 \"target\"');
      assert.equal(card.structuredContent.target, 'mcpops@127.0.0.1:22');
      const blind = await client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: 'blind-model-call' } }); assert.equal(blind.isError, true);
      if (enabled) {
        const cap = card._meta.sshApproval.approvalTicket;
        const decision = await client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: cap } }); assert.equal(decision.structuredContent.state, 'running');
        await application.queue.wait(job.id); assert.equal(calls.length, 1);
        const replay = await client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: cap } }); assert.equal(replay.isError, true);
      } else assert.equal(card._meta.sshApproval.approvalTicket, undefined);
      const web = `http://127.0.0.1:${application.adminHttp.address().port}`;
      const page = await (await fetch(web)).text();
      assert.ok(page.includes('data-bridge-display-name="시험 &lt;bridge&gt; &amp; $&amp;"'));
      assert.ok(page.includes('data-target-display-name="운영 &quot;target&quot;"'));
      assert.ok(page.includes('<title>시험 &lt;bridge&gt; &amp; $&amp; · 운영 &quot;target&quot;'));
      assert.ok(!page.includes('test-admin')); assert.ok(!page.includes('mcpops@127.0.0.1'));
      const second = application.queue.submit('sudo id');
      const headers = { Authorization: 'Bearer test-admin', Origin: 'https://evil.test' };
      assert.equal((await fetch(`${web}/api/${second.id}/approve`, { method: 'POST', headers })).status, 403);
      headers.Origin = 'https://example.test';
      assert.equal((await fetch(`${web}/api/${second.id}/deny`, { method: 'POST', headers })).status, 200);
      assert.equal(application.queue.get(second.id).state, 'denied');
    } finally { await client?.close(); await application.close(); await rm(root, { recursive: true }); }
  }
});
