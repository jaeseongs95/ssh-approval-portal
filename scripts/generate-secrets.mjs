import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, isAbsolute } from 'node:path';
import { parseSecretText } from '../src/adapters/config/secrets.mjs';
import { settingsContract, validateOrigin, validatedPort } from '../src/adapters/config/settings.mjs';

/** The rename is the commit point: failed staging leaves the previous file byte-for-byte intact. */
export async function generateSecrets(file, origin, { io = fs } = {}) {
  if (!isAbsolute(file)) throw Error('Use an absolute env path');
  let text = '', previous, input;
  try {
    input = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (input) {
    try {
      previous = await input.stat();
      const entry = await io.lstat(file);
      if (!previous.isFile() || entry.isSymbolicLink() || previous.ino !== entry.ino || previous.dev !== entry.dev ||
          (process.platform !== 'win32' && (previous.mode & 0o077)) || previous.size > 65536) throw Error('Expected a private regular secret file');
      text = await input.readFile('utf8');
    } finally { await input.close(); }
  }
  const settings = parseSecretText(text);
  validateOrigin(settings.BRIDGE_ADMIN_ORIGIN ?? origin);
  for (const key of ['BRIDGE_MCP_PORT', 'BRIDGE_ADMIN_PORT']) validatedPort(settings[key] ?? settingsContract.defaults[key]);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const append = (key, value) => {
    if (Object.hasOwn(settings, key)) return;
    if (text && !text.endsWith('\n')) text += newline;
    text += `${key}=${value}${newline}`;
  };
  for (const key of ['BRIDGE_MCP_TOKEN', 'BRIDGE_ADMIN_TOKEN', 'BRIDGE_UI_TICKET_KEY']) append(key, randomBytes(32).toString('hex'));
  append('BRIDGE_ADMIN_ORIGIN', origin);
  append('BRIDGE_UI_ENABLED', settingsContract.defaults.BRIDGE_UI_ENABLED);
  append('BRIDGE_UI_TOOL_PREFIX', settingsContract.defaults.BRIDGE_UI_TOOL_PREFIX);
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(12).toString('hex')}`);
  let handle, created = false, committed = false;
  try {
    handle = await io.open(temporary, 'wx', 0o600);
    created = true;
    if (previous && process.platform !== 'win32') await handle.chown(previous.uid, previous.gid);
    await handle.chmod(0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await io.rename(temporary, file); committed = true;
    let directory;
    try { directory = await io.open(dirname(file), 'r'); await directory.sync(); }
    catch (error) { if (!['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error; }
    finally { await directory?.close(); }
  } finally {
    await handle?.close();
    if (created && !committed) await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (import.meta.main) {
  try {
    await generateSecrets(...process.argv.slice(2));
    console.log('Secret configuration prepared. Values were not printed.');
  } catch {
    console.error('Secret configuration refused; verify the private file and canonical HTTPS origin.');
    process.exitCode = 1;
  }
}
