import settingsContract from '../../../config/settings-contract.json' with { type: 'json' };
import { MAX_BYTES } from '../../contracts/ports.mjs';
import { equalSecret } from '../security/tickets.mjs';

export { settingsContract };

export function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Configure one canonical HTTPS administrator origin'); }
  if (typeof value !== 'string' || !new RegExp(settingsContract.originPattern).test(value) ||
      url.protocol !== 'https:' || url.origin !== value || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) {
    throw Error('Configure one canonical HTTPS administrator origin');
  }
  return value;
}

export function validatedPort(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw Error('Configure a TCP port from 1 to 65535');
  return Number(value);
}

export function parseSettings(env) {
  const value = key => env[key] ?? settingsContract.defaults[key];
  const mcpToken = env.BRIDGE_MCP_TOKEN, adminToken = env.BRIDGE_ADMIN_TOKEN;
  if (!mcpToken || !adminToken || equalSecret(mcpToken, adminToken)) throw Error('Configure distinct MCP and administrator tokens');
  const adminOrigin = validateOrigin(env.BRIDGE_ADMIN_ORIGIN);
  const prefix = value('BRIDGE_UI_TOOL_PREFIX');
  if (!/^[A-Za-z0-9_-]*$/.test(prefix)) throw Error('Invalid UI namespace');
  const maxBytes = Number(value('BRIDGE_TRANSFER_MAX_BYTES')), budget = Number(value('BRIDGE_TRANSFER_BUDGET_BYTES'));
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES || !Number.isSafeInteger(budget) || budget < maxBytes) throw Error('Invalid staging limits');
  return Object.freeze({ mcpToken, adminToken, adminOrigin, uiEnabled: value('BRIDGE_UI_ENABLED') === 'true', prefix, maxBytes, budget,
    uploadHosts: Object.freeze(value('BRIDGE_UPLOAD_SOURCE_HOSTS').split(',').filter(Boolean)),
    mcpPort: validatedPort(value('BRIDGE_MCP_PORT')), adminPort: validatedPort(value('BRIDGE_ADMIN_PORT')),
    readProfile: 'aws-readonly', writeProfile: 'aws-local' });
}
