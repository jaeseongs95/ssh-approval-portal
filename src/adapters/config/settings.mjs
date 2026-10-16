import settingsContract from '../../../config/settings-contract.json' with { type: 'json' };
import { MAX_BYTES } from '../../contracts/ports.mjs';
import { equalSecret } from '../security/tickets.mjs';
import { domainToASCII, domainToUnicode } from 'node:url';
import { parseUploadHosts } from './upload-hosts.mjs';
import { parseTargets } from './targets.mjs';

export { settingsContract };

export function validateOrigin(value) {
  if (typeof value !== 'string' || value.length > settingsContract.originMaxBytes) throw Error('Configure one canonical HTTPS administrator origin');
  let url;
  try { url = new URL(value); } catch { throw Error('Configure one canonical HTTPS administrator origin'); }
  // Some Node patch builds preserve malformed ACE labels; require a real decode and canonical round trip.
  for (const label of url.hostname.split('.')) {
    if (!label.startsWith('xn--')) continue;
    const unicode = domainToUnicode(label);
    if (!unicode || unicode === label || domainToASCII(unicode) !== label) throw Error('Configure one canonical HTTPS administrator origin');
  }
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

function displayName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw Error('Display names must be at most 80 characters without control or formatting characters');
  return value.trim();
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
  return Object.freeze({ mcpToken, adminToken, adminOrigin,
    targets: parseTargets(value('BRIDGE_TARGETS'), value('BRIDGE_DEFAULT_TARGET')),
    defaultTarget: value('BRIDGE_DEFAULT_TARGET') || undefined,
    bridgeDisplayName: displayName(value('BRIDGE_DISPLAY_NAME')) || new URL(adminOrigin).host,
    targetDisplayName: displayName(value('BRIDGE_TARGET_DISPLAY_NAME')) || 'SSH', uiEnabled: value('BRIDGE_UI_ENABLED') === 'true', prefix, maxBytes, budget,
    uploadHosts: Object.freeze(parseUploadHosts(value('BRIDGE_UPLOAD_SOURCE_HOSTS'))),
    mcpPort: validatedPort(value('BRIDGE_MCP_PORT')), adminPort: validatedPort(value('BRIDGE_ADMIN_PORT')),
    readProfile: 'aws-readonly', writeProfile: 'aws-local' });
}
