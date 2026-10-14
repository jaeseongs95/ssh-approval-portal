import { openSync, fsyncSync, closeSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadConfig } from 'ssh-mcp/build/config/loader.js';
import { ConnectionRegistry } from 'ssh-mcp/build/ssh/connection-registry.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { commandOutput } from 'ssh-mcp/build/tools/results.js';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';
import { readFile } from 'node:fs/promises';
import { createApplication } from './app.mjs';
import { hash, writeAll } from './core.mjs';
import { loadSecrets } from './secrets.mjs';

if (createRequire(import.meta.url)('ssh-mcp/package.json').version !== '2.18.0') throw Error('Requires ssh-mcp 2.18.0');
const settings = await loadSecrets();
for (const [key, value] of Object.entries(settings)) if (key.startsWith('SSH_MCP_')) process.env[key] = value;
const config = await loadConfig(settings.BRIDGE_CONFIG_PATH);
const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');
const auditPath = settings.BRIDGE_AUDIT_PATH ?? '/var/lib/ssh-mcp/.local/share/ssh-mcp/approval-bridge-audit.jsonl';
function audit(event) {
  // Explicit metadata allowlist: never serialize result, tickets or transfer payloads.
  const operation = event.operation;
  const record = { at: new Date().toISOString(), action: event.action, id: event.id, kind: event.kind ?? operation?.kind, profile: event.profile, target: event.target, commandClass: event.commandClass };
  const command = event.command ?? operation?.command;
  if (command) { record.commandHash = hash(command); record.command = redactText(command, { entropyScan: true }); }
  if (operation && operation.kind !== 'command') Object.assign(record, { remotePath: operation.remotePath, sha256: operation.sha256, size: operation.size, overwrite: operation.overwrite, elevate: operation.elevate });
  const fd = openSync(auditPath, 'a', 0o600);
  try { writeAll(fd, Buffer.from(JSON.stringify(record) + '\n'), writeSync); fsyncSync(fd); } finally { closeSync(fd); }
}
const uiHtml = await readFile(new URL('./ui/dist/card.html', import.meta.url), 'utf8');
const app = await createApplication({ registry, classify: classifyCommand, audit, uiHtml, env: settings,
  transferRoot: settings.BRIDGE_TRANSFER_ROOT ?? '/var/lib/ssh-mcp/transfers',
  executeCommand: async (profile, command) => commandOutput(await (await registry.getOrCreate(profile)).exec(command)),
});
app.mcpHttp.listen(Number(settings.BRIDGE_MCP_PORT ?? 39124), '127.0.0.1');
app.adminHttp.listen(Number(settings.BRIDGE_ADMIN_PORT ?? 39125), '127.0.0.1');
console.error('SSH Approval Portal 0.3.0 listening on loopback; UI actions ' + (app.enabled ? 'enabled' : 'disabled (probe only)'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
