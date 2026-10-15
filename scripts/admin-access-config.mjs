import { readFile, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { accessConfiguration } from '../src/adapters/security/admin-access.mjs';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';

export function updateAccessSettings(text, values) {
  const config = accessConfiguration({ ...values, BRIDGE_ADMIN_AUTH_MODE: 'access' });
  const normalized = { BRIDGE_ADMIN_AUTH_MODE:'access', BRIDGE_ACCESS_TEAM_DOMAIN:config.issuer, BRIDGE_ACCESS_AUD:config.audience, BRIDGE_ACCESS_OWNER_EMAILS:config.owners.join(',') };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const keys = ['BRIDGE_ADMIN_AUTH_MODE', 'BRIDGE_ACCESS_TEAM_DOMAIN', 'BRIDGE_ACCESS_AUD', 'BRIDGE_ACCESS_OWNER_EMAILS'];
  const kept = text.split(/\r?\n/).filter(line => !keys.some(key => line.startsWith(key + '='))).join(newline);
  return kept + (kept.endsWith(newline) ? '' : newline) + keys.map(key => `${key}=${normalized[key]}`).join(newline) + newline;
}

if (import.meta.main) {
  const [source, destination] = process.argv.slice(2);
  if (!['/etc/ssh-mcp-approval-bridge.env','/etc/ssh-approval-portal/docker-secrets.env'].includes(source) || !destination?.startsWith('/')) throw Error('Use a managed secret file and absolute staging file');
  const inputFile = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const stat = await inputFile.stat(), entry = await lstat(source);
    if (!stat.isFile() || entry.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 65536 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw Error('Expected a private regular secret file');
    text = await inputFile.readFile('utf8');
    parseSecretText(text);
  } finally { await inputFile.close(); }
  let values;
  if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      values = { BRIDGE_ACCESS_TEAM_DOMAIN: (await input.question('Access team domain (https://TEAM.cloudflareaccess.com): ')).trim(),
        BRIDGE_ACCESS_AUD: (await input.question('ssh-approve application AUD (64 hex characters): ')).trim(),
        BRIDGE_ACCESS_OWNER_EMAILS: (await input.question('Exact owner email(s), comma separated: ')).trim() };
    } finally { input.close(); }
  } else values = JSON.parse(await readFile('/dev/stdin','utf8'));
  const output = await open(destination, 'wx', 0o600);
  try { await output.writeFile(updateAccessSettings(text, values), 'utf8'); await output.sync(); }
  finally { await output.close(); }
  console.log('Owner Access settings staged. Secrets were preserved and not printed.');
}
