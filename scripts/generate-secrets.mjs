import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
const [file, origin] = process.argv.slice(2);
if (!file?.startsWith('/')) throw Error('Use an absolute env path');
let text;
try { text = await readFile(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; text = ''; }
const existing = name => new RegExp('^' + name + '=', 'm').test(text);
if (!existing('BRIDGE_ADMIN_ORIGIN') && !/^https:\/\/[^/\s]+$/.test(origin ?? '')) throw Error('Initial installation needs one HTTPS admin origin');
for (const key of ['BRIDGE_MCP_TOKEN', 'BRIDGE_ADMIN_TOKEN', 'BRIDGE_UI_TICKET_KEY']) if (!existing(key)) text += `\n${key}=${randomBytes(32).toString('hex')}\n`;
if (!existing('BRIDGE_ADMIN_ORIGIN')) text += `BRIDGE_ADMIN_ORIGIN=${origin}\n`;
if (!existing('BRIDGE_UI_ENABLED')) text += 'BRIDGE_UI_ENABLED=false\n';
if (!existing('BRIDGE_UI_TOOL_PREFIX')) text += 'BRIDGE_UI_TOOL_PREFIX=ssh-approval-bridge_\n';
await writeFile(file, text, { mode: 0o600 }); await chmod(file, 0o600);
console.log('Secret configuration prepared. Values were not printed.');
