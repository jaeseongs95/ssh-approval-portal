import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateLocalPath } from './local-files.mjs';

const fail = code => Object.assign(new Error(code), { code });

// Explicit configuration wins even when broken. Never silently execute a different helper.
// PATH is the caller's normal executable trust boundary; do not scan the disk or current dir.
export async function resolveCloudflared({ explicit, env = process.env } = {}) {
  if (explicit !== undefined || env.PORTAL_CLOUDFLARED !== undefined) {
    const path = explicit ?? env.PORTAL_CLOUDFLARED;
    validateLocalPath(path);
    return { path, source: explicit !== undefined ? 'argument' : 'environment' };
  }
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  if (typeof pathValue !== 'string' || pathValue.length > 32768) throw fail('CLOUDFLARED_DISCOVERY_LIMIT');
  const directories = pathValue.split(delimiter);
  if (directories.length > 256) throw fail('CLOUDFLARED_DISCOVERY_LIMIT');
  for (const raw of directories) {
    const directory = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!isAbsolute(directory)) continue;
    const path = join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    try {
      validateLocalPath(path);
      if (!(await stat(path)).isFile()) continue;
      await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return { path, source: 'path' };
    } catch { /* An unusable PATH entry is not proof that portable installations are absent. */ }
  }
  throw fail('CLOUDFLARED_NOT_FOUND');
}

export function cachedAccessToken(path, origin, run = execFileSync, timeoutMs = 30000) {
  let token;
  try {
    token = run(path, ['access', 'token', '--app=' + origin], { encoding: 'utf8', timeout: Math.min(30000, timeoutMs),
      maxBuffer: 16386, killSignal: 'SIGKILL', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw fail(({ ENOENT: 'CLOUDFLARED_NOT_FOUND', EACCES: 'CLOUDFLARED_NOT_EXECUTABLE', EPERM: 'CLOUDFLARED_NOT_EXECUTABLE',
      ETIMEDOUT: 'ACCESS_CREDENTIAL_TIMEOUT', ENOBUFS: 'ACCESS_CREDENTIAL_TOO_LARGE' })[error?.code] ?? 'ACCESS_CREDENTIAL_UNAVAILABLE');
  }
  if (typeof token !== 'string') throw fail('INVALID_ACCESS_CREDENTIAL');
  token = token.replace(/\r?\n$/, '');
  if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw fail('INVALID_ACCESS_CREDENTIAL');
  return token;
}
