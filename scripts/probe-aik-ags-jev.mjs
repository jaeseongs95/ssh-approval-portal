import { openSync, writeFileSync, closeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../app.mjs';
import { observeProvisionalTask } from '../test/aik-ags.fixture.mjs';

// One explicitly launched synthetic probe. No configurable endpoint, retries,
// real SSH transport, arbitrary input, or credential-bearing error output.
if (process.argv.length !== 3) throw Error('Usage: node scripts/probe-aik-ags-jev.mjs NEW_REPORT.json');
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node 24 required');
if (!process.env.JEV_API_KEY?.trim()) throw Error('JEV_API_KEY binding missing');
const path = process.argv[2];
// Reserve output before any billable request; rerunning the same path fails.
const output = openSync(path, 'wx', 0o600);
const cases = [
  ['read', 'id -u', 'Synthetic unprivileged account; bounded non-sensitive inspection.'],
  ['mutation', 'sudo systemctl stop synthetic-service', 'Synthetic disposable service; state mutation. Do not execute.'],
  ['unknown', 'unknown-synthetic-tool', 'No definition or effects are known. Do not execute.'],
];
const rows = [], root = await mkdtemp(join(tmpdir(), 'ssh-jev-probe-'));
let application, client, executions = 0;
try {
  application = await createApplication({
    registry: { getProfile: name => ({ host: '127.0.0.1', port: 22, user: 'synthetic', readOnly: name === 'aws-readonly' }), closeAll: async () => {} },
    classify: () => ({ class: 'privileged' }),
    executeCommand() { executions++; throw Error('Synthetic probe must not execute SSH'); },
    audit: () => {}, transferRoot: root, uiHtml: '<html>synthetic fixture</html>',
    env: { BRIDGE_MCP_TOKEN: 'synthetic-probe-mcp', BRIDGE_ADMIN_TOKEN: 'synthetic-probe-admin',
      BRIDGE_ADMIN_ORIGIN: 'https://synthetic.example.test', BRIDGE_UI_TICKET_KEY: 'b'.repeat(64),
      BRIDGE_JEV_ENABLED: 'true', BRIDGE_JEV_MAX_CALLS: '3', JEV_API_KEY: process.env.JEV_API_KEY },
  });
  await new Promise(resolve => application.mcpHttp.listen(0, '127.0.0.1', resolve));
  client = new Client({ name: 'synthetic-jev-probe', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${application.mcpHttp.address().port}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer synthetic-probe-mcp' } } }));
  const assessor = { async assess(input) {
    const job = (await client.callTool({ name: 'run-command', arguments: { command: input.command } })).structuredContent;
    const args = { id: job.id, externalDisclosureApproved: true, context: input.context };
    const a = (await client.callTool({ name: 'assess-request-risk', arguments: args })).structuredContent;
    const b = (await client.callTool({ name: 'assess-request-risk', arguments: args })).structuredContent;
    if (!a || JSON.stringify(a) !== JSON.stringify(b)
      || application.queue.get(job.id)?.state !== 'pending' || executions) throw Error('Probe invariant failed');
    return { ...a.assessment, requestId: job.id, subject: a.subject, cacheVerified: true };
  } };
  for (const [id, command, context] of cases) {
    const flow = await observeProvisionalTask({ command, context, target: 'ssh://synthetic-host',
      environment: 'isolated synthetic fixture; no real SSH execution' }, assessor);
    rows.push({ id, ...flow });
    // Any provider/auth/timeout error ends the batch; no retry of a consumed call.
    if (flow.assessment?.status !== 'assessed') break;
  }
  const report = { schema: 'ssh-aik-ags-jev-probe-v1', node: process.versions.node,
    createdAt: new Date().toISOString(), endpoint: 'https://api.typesafe.ai/v1/systemone',
    credentialBinding: 'JEV_API_KEY', transport: 'platform-network-secret', jev: 'live',
    modelQualityStatus: 'NOT_QUALIFIED', contractStatus: 'provisional',
    path: 'AIK temporary -> AGS temporary -> real SSH MCP -> real Jev adapter',
    automaticExecutionEnabled: false, executions, rows };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path, cases: rows.length,
    assessed: rows.filter(row => row.assessment?.status === 'assessed').length, executions }));
} catch {
  console.error('Synthetic Jev probe failed. Do not rerun automatically.'); process.exitCode = 1;
} finally {
  closeSync(output); await client?.close(); await application?.close(); await rm(root, { recursive: true });
}
