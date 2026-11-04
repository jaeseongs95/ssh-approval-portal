import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../native/freerdp-input/runtime/', import.meta.url));
export const nativeRdpExecutable = join(root, 'bin', 'xfreerdp3');
const upstream = 'bf217a504e54cc719880c228e82353382cd7d4fa';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(Error(code), { code }); };

export function nativeRdpCapabilities({ platform, executable, executableSha256, patchDigest, native } = {}) {
  const available = platform === 'linux' && executable === nativeRdpExecutable
    && digest(executableSha256) && digest(patchDigest) && native && typeof native === 'object'
    && !Array.isArray(native) && Object.keys(native).sort().join(',') === 'patchDigest,protocol,upstreamCommit'
    && native.protocol === 'ags-native-input/1' && native.upstreamCommit === upstream && native.patchDigest === patchDigest;
  return available ? { available: true, executable, executableSha256, patchDigest } : { available: false, executable: null };
}

async function verifiedRuntime() {
  const descriptor = await open(join(root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile() || stat.size > 131072) fail('DESKTOP_RDP_NATIVE_MANIFEST');
    manifest = JSON.parse(await descriptor.readFile('utf8'));
  } finally { await descriptor.close(); }
  if (manifest?.format !== 'portal.freerdp-native.v1' || manifest.upstreamVersion !== '3.32.1'
    || manifest.upstreamCommit !== upstream || !digest(manifest.patchSha256) || manifest.executable !== 'bin/xfreerdp3'
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 256) fail('DESKTOP_RDP_NATIVE_MANIFEST');
  const names = new Set(); let total = 0, executableSha256;
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || !/^[A-Za-z0-9_+./-]+$/.test(item.path)
      || item.path.startsWith('/') || item.path.split('/').some(part => !part || part === '.' || part === '..')
      || names.has(item.path) || !digest(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1
      || item.size > 32 * 1024 * 1024 || (total += item.size) > 256 * 1024 * 1024
      || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) fail('DESKTOP_RDP_NATIVE_MANIFEST');
    names.add(item.path);
    const file = await open(join(root, ...item.path.split('/')), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size !== item.size || (before.mode & 0o777) !== item.mode) fail('DESKTOP_RDP_NATIVE_HASH_MISMATCH');
      const hash = createHash('sha256');
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
      const after = await file.stat();
      if (hash.digest('hex') !== item.sha256 || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('DESKTOP_RDP_NATIVE_HASH_MISMATCH');
      if (item.path === manifest.executable) {
        if (!(item.mode & 0o111)) fail('DESKTOP_RDP_NATIVE_MANIFEST');
        executableSha256 = item.sha256;
      }
    } finally { await file.close(); }
  }
  if (!executableSha256) fail('DESKTOP_RDP_NATIVE_MANIFEST');
  // RUNPATH libraries must belong to the same manifest as the executable.
  const directories = ['']; let entries = 0;
  while (directories.length) {
    const directory = directories.pop(), path = join(root, directory);
    if (!(await lstat(path)).isDirectory()) fail('DESKTOP_RDP_NATIVE_MANIFEST');
    for (const name of await readdir(path)) {
      if (++entries > 512) fail('DESKTOP_RDP_NATIVE_MANIFEST');
      const relative = directory ? `${directory}/${name}` : name;
      const stat = await lstat(join(root, relative));
      if (stat.isDirectory()) directories.push(relative);
      else if (!stat.isFile() || relative !== 'manifest.json' && !names.has(relative)) fail('DESKTOP_RDP_NATIVE_MANIFEST');
    }
  }
  return { executableSha256, patchDigest: manifest.patchSha256 };
}

/** Only the release's private, verified runtime is eligible; never fall back to a stock client. */
export async function readNativeRdpCapabilities() {
  if (process.platform !== 'linux') return { available: false, executable: null, reason: 'DESKTOP_RDP_CLIENT_UNAVAILABLE' };
  let home;
  try {
    const verified = await verifiedRuntime();
    home = await mkdtemp(join(tmpdir(), 'portal-rdp-probe-'));
    const result = await run(nativeRdpExecutable, ['/ags-input-capabilities'], { timeout: 5000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_RUNTIME_DIR: home } });
    const capabilities = nativeRdpCapabilities({ platform: process.platform, executable: nativeRdpExecutable,
      ...verified, native: JSON.parse(result.stdout) });
    return capabilities.available ? capabilities : { ...capabilities, reason: 'DESKTOP_RDP_NATIVE_CAPABILITY_MISMATCH' };
  } catch (error) {
    const reason = /^DESKTOP_RDP_NATIVE_[A-Z_]+$/.test(error?.code) ? error.code
      : error?.code === 'ENOENT' ? 'DESKTOP_RDP_NATIVE_MISSING' : 'DESKTOP_RDP_NATIVE_PROBE_FAILED';
    return { available: false, executable: null, reason };
  } finally { if (home) await rm(home, { recursive: true, force: true }); }
}
