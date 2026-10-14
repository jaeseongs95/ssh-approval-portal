import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../app.mjs';
const root = await mkdtemp(join(tmpdir(), 'ssh-malformed-'));
const profile = { host: 'localhost', port: 22, user: 'mcpops' };
const app = await createApplication({ registry: { getProfile: name => ({ ...profile, readOnly: name === 'aws-readonly' }), closeAll: async () => {} }, classify: () => ({ class: 'read-only' }), executeCommand: async () => ({}), audit: () => {}, transferRoot: root,
  env: { BRIDGE_MCP_TOKEN: 'fixture-mcp', BRIDGE_ADMIN_TOKEN: 'fixture-admin', BRIDGE_ADMIN_ORIGIN: 'https://example.test', BRIDGE_UI_TICKET_KEY: 'c'.repeat(64) }, uiHtml: '<html>fixture</html>' });
await new Promise(resolve => app.adminHttp.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => app.mcpHttp.listen(0, '127.0.0.1', resolve));
process.send({ adminPort: app.adminHttp.address().port, mcpPort: app.mcpHttp.address().port });
process.on('message', async message => { if (message === 'stop') { await app.close(); await rm(root, { recursive: true }); process.exit(0); } });
