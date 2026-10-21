import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { accessConfiguration } from '../src/adapters/security/admin-access.mjs';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';

function oidcEnvValue(value) {
  // Both the Node literal reader and native systemd EnvironmentFile must receive
  // the same bytes. Single quotes preserve backslashes; never add escape text.
  if (!value.includes("'")) return "'" + value + "'";
  if (!/["\\]/.test(value)) return '"' + value + '"';
  throw Error('OIDC value requires unsupported managed ENV quoting');
}

export function updateAccessSettings(text, values, mode = 'access') {
  if (!['access', 'oidc'].includes(mode)) throw Error('Unknown owner authentication mode');
  const config = accessConfiguration({ ...values, BRIDGE_ADMIN_AUTH_MODE: mode });
  const normalized = mode === 'oidc'
    ? { BRIDGE_ADMIN_AUTH_MODE:mode, BRIDGE_OIDC_ISSUER:config.issuer, BRIDGE_OIDC_JWKS_URL:config.jwksUrl, BRIDGE_OIDC_CLIENT_ID:config.audience, BRIDGE_OIDC_OWNER_EMAILS:config.owners.join(',') }
    : { BRIDGE_ADMIN_AUTH_MODE:mode, BRIDGE_ACCESS_TEAM_DOMAIN:config.issuer, BRIDGE_ACCESS_AUD:config.audience, BRIDGE_ACCESS_OWNER_EMAILS:config.owners.join(',') };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const keys = Object.keys(normalized);
  const kept = text.split(/\r?\n/).filter(line => !keys.some(key => line.startsWith(key + '='))).join(newline);
  const rendered = kept + (kept.endsWith(newline) ? '' : newline) + keys.map(key => `${key}=${mode === 'oidc' ? oidcEnvValue(normalized[key]) : normalized[key]}`).join(newline) + newline;
  if (Buffer.byteLength(rendered) > 65536) throw Error('Owner settings file is too large');
  // Managed ENV uses the literal parser, never shell evaluation or JSON escapes.
  const parsed = parseSecretText(rendered);
  if (keys.some(key => parsed[key] !== normalized[key])) throw Error('Owner settings cannot be represented in managed ENV');
  return rendered;
}

export function restoreAccessSettings(current, expected, original, mode = 'access') {
  if ([current, expected, original].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 65536)) throw Error('Invalid Access restore input');
  if (current !== expected) throw Error('Configuration changed after Access setup');
  parseSecretText(original);
  if (updateAccessSettings(original, parseSecretText(expected), mode) !== expected) throw Error('Restore would change unrelated settings');
  return original;
}

async function readInput() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 524288) throw Error('Access input is too large');
  }
  return JSON.parse(text);
}

if (import.meta.main) {
  try {
  const [source, destination, mode, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== undefined && !['--oidc', '--restore-owned-access', '--link-owned-access', '--restore-owned-oidc', '--link-owned-oidc'].includes(mode))) throw Error('Unknown owner configuration mode');
  const authMode = mode?.endsWith('oidc') ? 'oidc' : 'access';
  const restore = mode?.startsWith('--restore-owned-');
  if (!['/etc/ssh-mcp-approval-bridge.env','/etc/ssh-approval-portal/docker-secrets.env'].includes(source) || !destination?.startsWith('/')) throw Error('Use a managed secret file and absolute staging file');
  const inputFile = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const stat = await inputFile.stat(), entry = await lstat(source);
    if (!stat.isFile() || entry.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 65536 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw Error('Expected a private regular secret file');
    text = await inputFile.readFile('utf8');
    parseSecretText(text);
  } finally { await inputFile.close(); }
  let values, rendered;
  if (mode?.includes('-owned-')) {
    if (process.stdin.isTTY) throw Error('Owned Access restoration requires private standard input');
    const input = await readInput();
    const keys = restore ? 'expected,original' : 'expected,values';
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== keys) throw Error('Invalid owned Access input');
    if (text !== input.expected) throw Error('Configuration changed during Access setup');
    rendered = restore ? restoreAccessSettings(text, input.expected, input.original, authMode)
      : updateAccessSettings(text, input.values, authMode);
  } else if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      values = authMode === 'oidc' ? {
        BRIDGE_OIDC_ISSUER: (await input.question('OIDC issuer (exact HTTPS URL): ')).trim(),
        BRIDGE_OIDC_JWKS_URL: (await input.question('OIDC JWKS (exact HTTPS URL): ')).trim(),
        BRIDGE_OIDC_CLIENT_ID: (await input.question('OIDC client ID (public, not client secret): ')).trim(),
        BRIDGE_OIDC_OWNER_EMAILS: (await input.question('Exact owner email(s), comma separated: ')).trim(),
      } : { BRIDGE_ACCESS_TEAM_DOMAIN: (await input.question('Access team domain (https://TEAM.cloudflareaccess.com): ')).trim(),
        BRIDGE_ACCESS_AUD: (await input.question('ssh-approve application AUD (64 hex characters): ')).trim(),
        BRIDGE_ACCESS_OWNER_EMAILS: (await input.question('Exact owner email(s), comma separated: ')).trim() };
    } finally { input.close(); }
  } else values = await readInput();
  if (rendered === undefined) rendered = updateAccessSettings(text, values, authMode);
  const output = await open(destination, 'wx', 0o600);
  try { await output.writeFile(rendered, 'utf8'); await output.sync(); }
  finally { await output.close(); }
  console.log('Owner Access settings staged. Secrets were preserved and not printed.');
  } catch (error) {
    const code = ['EACCES', 'EPERM', 'ENOENT', 'ENXIO', 'EAGAIN', 'EEXIST'].includes(error?.code) ? error.code : 'INVALID_INPUT';
    console.error(`Owner Access settings were not staged (${code}). Check the managed configuration and input.`);
    process.exitCode = 1;
  }
}
