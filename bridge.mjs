import { readFile } from 'node:fs/promises';
import { createApplication } from './app.mjs';
import { loadSecrets } from './src/adapters/config/secrets.mjs';
import { parseSettings } from './src/adapters/config/settings.mjs';
import { createAudit } from './src/adapters/audit/jsonl.mjs';
import { createSshRuntime } from './src/adapters/ssh/vendor.mjs';

const env = await loadSecrets();
const settings = parseSettings(env);
const { registry, classify, executeCommand, auditRedact } = await createSshRuntime(env);
const audit = createAudit({ path: env.BRIDGE_AUDIT_PATH ?? '/var/lib/ssh-mcp/.local/share/ssh-mcp/approval-bridge-audit.jsonl', redact: auditRedact });
const uiHtml = await readFile(new URL('./ui/dist/card.html', import.meta.url), 'utf8');
const app = await createApplication({ registry, classify, executeCommand, audit, uiHtml, env,
  transferRoot: env.BRIDGE_TRANSFER_ROOT ?? '/var/lib/ssh-mcp/transfers' });
app.mcpHttp.listen(settings.mcpPort, '127.0.0.1');
app.adminHttp.listen(settings.adminPort, '127.0.0.1');
console.error('SSH Approval Portal 1.1.0 listening on loopback; UI actions ' + (app.enabled ? 'enabled' : 'disabled (probe only)'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
