import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// 1.7 baseline: test/legacy-17/http.test.mjs.17. Separate read/run and output tools map to submit/observe.
// HTTP integration oracle: authentication, bound output disclosure, private owner tickets and web-origin refusal.
// Product execution is remote-only; local validation is limited to node --check and git diff --check.
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
      const targetList = (await client.callTool({ name: 'targets', arguments: {} })).structuredContent;
      assert.equal(targetList.ok, true);
      const selected = targetList.data.targets.find(target => target.id === (targetList.data.defaultTarget ?? 'default'));
      assert.ok(selected?.revision);
      const binding = { target: selected.id, expectedTargetRevision: selected.revision };
      assert.ok(tools.tools.every(tool => !['read-command', 'run-command', 'read-command-output'].includes(tool.name)));
      for (const suffix of ['read-path', 'run-path']) {
        const args = { kind: 'command', operationKey: `http-${suffix}-${enabled}-operation`, command: 'id -un', ...binding };
        const read = await client.callTool({ name: 'submit', arguments: args });
        assert.equal(read.structuredContent.ok, true);
        assert.ok(!JSON.stringify(read).includes('"text":"mcpops"'));
        assert.equal(read.structuredContent.data.outputPage, null);
        let observed = read.structuredContent.data;
        for (let attempt = 0; observed.state !== 'completed' && attempt < 20; attempt++) {
          const result = await client.callTool({ name: 'observe', arguments: { id: observed.id, waitMs: 1000 } });
          assert.equal(result.structuredContent.ok, true);
          observed = result.structuredContent.data;
          if (['failed', 'cancelled', 'denied', 'expired', 'unknown'].includes(observed.state)) break;
        }
        assert.equal(observed.state, 'completed');
        assert.equal(observed.outputPage, null, 'status does not disclose the output body');
        const output = await client.callTool({ name: 'observe', arguments: { id: observed.id, includeOutput: true } });
        assert.equal(output.structuredContent.ok, true);
        assert.equal(output.structuredContent.data.outputPage.text, 'mcpops');
        const replay = await client.callTool({ name: 'submit', arguments: args });
        assert.equal(replay.structuredContent.ok, true);
        assert.equal(replay.structuredContent.data.id, observed.id);
      }
      assert.equal(calls.length, 2, 'recovering each operation key does not execute it twice');
      calls.length = 0;
      const submitted = await client.callTool({ name: 'submit', arguments: { kind: 'command', operationKey: `http-owner-review-${enabled}`, command: 'sudo -n -l', ...binding } });
      assert.equal(submitted.structuredContent.ok, true);
      const job = submitted.structuredContent.data;
      assert.equal(calls.length, 0);
      const card = await client.callTool({ name: 'show-approval', arguments: { id: job.id } });
      assert.ok(!JSON.stringify(card.structuredContent).includes('Ticket'));
      assert.equal(card._meta.sshApproval.bridgeDisplayName, '시험 <bridge> & $&');
      assert.equal(card._meta.sshApproval.targetDisplayName, '운영 \"target\"');
      assert.equal(card.structuredContent.target, 'mcpops@127.0.0.1:22');
      const blind = await client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: 'blind-model-call' } }); assert.equal(blind.isError, true);
      if (enabled) {
        const cap = card._meta.sshApproval.approvalTicket;
        const decision = await client.callTool({ name: 'ui-decide-request', arguments: { id: job.id, action: 'approve', ticket: cap } }); assert.ok(['queued', 'starting', 'running', 'completed'].includes(decision.structuredContent.state));
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
