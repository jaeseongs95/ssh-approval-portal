import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { accessConfiguration } from '../admin-access.mjs';
import { loadSecrets } from '../secrets.mjs';

export function updateAccessSettings(text, values) {
  const config = accessConfiguration({ ...values, BRIDGE_ADMIN_AUTH_MODE: 'access' });
  const normalized = { BRIDGE_ADMIN_AUTH_MODE:'access', BRIDGE_ACCESS_TEAM_DOMAIN:config.issuer, BRIDGE_ACCESS_AUD:config.audience, BRIDGE_ACCESS_OWNER_EMAILS:config.owners.join(',') };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const keys = ['BRIDGE_ADMIN_AUTH_MODE', 'BRIDGE_ACCESS_TEAM_DOMAIN', 'BRIDGE_ACCESS_AUD', 'BRIDGE_ACCESS_OWNER_EMAILS'];
  const kept = text.split(/\r?\n/).filter(line => !keys.some(key => line.startsWith(key + '='))).join(newline);
  return kept + (kept.endsWith(newline) ? '' : newline) + keys.map(key => `${key}=${normalized[key]}`).join(newline) + newline;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination] = process.argv.slice(2);
  if (!['/etc/ssh-mcp-approval-bridge.env','/etc/ssh-approval-portal/docker-secrets.env'].includes(source) || !destination?.startsWith('/')) throw Error('Use a managed secret file and absolute staging file');
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('Expected a private regular secret file');
  await loadSecrets({}, source);
  let values;
  if (process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      values = { BRIDGE_ACCESS_TEAM_DOMAIN: (await input.question('Access team domain (https://TEAM.cloudflareaccess.com): ')).trim(),
        BRIDGE_ACCESS_AUD: (await input.question('ssh-approve application AUD (64 hex characters): ')).trim(),
        BRIDGE_ACCESS_OWNER_EMAILS: (await input.question('Exact owner email(s), comma separated: ')).trim() };
    } finally { input.close(); }
  } else values = JSON.parse(await readFile('/dev/stdin','utf8'));
  await writeFile(destination, updateAccessSettings(await readFile(source,'utf8'), values), { flag:'wx', mode:0o600 });
  console.log('Owner Access settings staged. Secrets were preserved and not printed.');
}
