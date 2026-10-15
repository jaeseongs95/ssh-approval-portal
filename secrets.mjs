import { readFile } from 'node:fs/promises';
const allowed = new Set(['BRIDGE_MCP_TOKEN', 'BRIDGE_ADMIN_TOKEN', 'BRIDGE_UI_TICKET_KEY', 'BRIDGE_ADMIN_ORIGIN', 'BRIDGE_UI_ENABLED', 'BRIDGE_UI_TOOL_PREFIX', 'BRIDGE_HOST_KEY_MODE', 'BRIDGE_TRANSFER_MAX_BYTES', 'BRIDGE_TRANSFER_BUDGET_BYTES', 'BRIDGE_CONFIG_PATH', 'BRIDGE_AUDIT_PATH', 'BRIDGE_TRANSFER_ROOT', 'BRIDGE_MCP_PORT', 'BRIDGE_ADMIN_PORT', 'BRIDGE_ADMIN_AUTH_MODE', 'BRIDGE_ACCESS_TEAM_DOMAIN', 'BRIDGE_ACCESS_AUD', 'BRIDGE_ACCESS_OWNER_EMAILS', 'BRIDGE_UPLOAD_SOURCE_HOSTS']);
export async function loadSecrets(env = process.env, file = env.BRIDGE_SECRET_ENV_FILE) {
  const settings = { ...env };
  if (!file) return settings;
  const text = await readFile(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match || (!allowed.has(match[1]) && !/^SSH_MCP_[A-Z0-9_]+$/.test(match[1]))) throw Error('Unsupported secret configuration entry');
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (/[\r\n\0]/.test(value)) throw Error('Invalid secret configuration value');
    settings[match[1]] = value;
  }
  return settings;
}
