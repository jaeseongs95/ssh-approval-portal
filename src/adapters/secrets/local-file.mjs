import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretError } from '../../application/secret-service.mjs';

const MAX_RECORD = 32 * 1024;
const nameOK = name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
const metadata = (name, record) => ({ name, revision: record.revision, updatedAt: record.updatedAt });

/** POSIX local disk adapter; same-UID/root compromise is outside its isolation boundary. */
export function createLocalSecretStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new SecretError('unsafe_store');
  const uid = process.geteuid?.();
  async function trustedAncestors(location) {
    if (uid === undefined) throw new SecretError('unsupported_platform');
    let current = path.parse(location).root;
    for (const component of ['', ...location.slice(current.length).split(path.sep).filter(Boolean)]) {
      current = path.join(current, component);
      const info = await fs.lstat(current);
      // Sticky directories protect entries owned by us/root (e.g. root-owned /tmp).
      if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw new SecretError('unsafe_store');
    }
  }
  async function privateDirectory(location) {
    await trustedAncestors(location);
    const info = await fs.lstat(location);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o700 || await fs.realpath(location) !== location) throw new SecretError('unsafe_store');
  }
  const checkRoot = async () => {
    await privateDirectory(path.dirname(directory)); await privateDirectory(directory);
    const marker = await fs.open(path.join(directory, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await marker.stat(), bytes = Buffer.alloc(3);
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size !== 2) throw new SecretError('unsafe_store');
      const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== 2 || bytes.subarray(0, 2).toString() !== '*\n') throw new SecretError('unsafe_store');
    } finally { await marker.close(); }
  };
  const location = name => { if (!nameOK(name)) throw new SecretError('invalid_reference'); return path.join(directory, name + '.json'); };
  async function record(name) {
    await checkRoot();
    let handle;
    try {
      const before = await fs.lstat(location(name));
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new SecretError('unsafe_record');
      handle = await fs.open(location(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      // A concurrent atomic replacement may unlink the already-open old record.
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink > 1 || info.size > MAX_RECORD) throw new SecretError('unsafe_record');
      const buffer = Buffer.alloc(MAX_RECORD + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break; length += bytesRead;
      }
      if (length > MAX_RECORD) throw new SecretError('unsafe_record');
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); } catch { throw new SecretError('invalid_record'); }
      if (!value || value.kind !== 'secret-record' || value.schema !== 1 || typeof value.value !== 'string' || !value.value || Buffer.byteLength(value.value) > 16384 || value.value.includes('\0') || typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new SecretError('invalid_record');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { await handle?.close(); }
  }
  async function syncDirectory() { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  async function writeOperation(action) {
    await checkRoot();
    let lock;
    try { lock = await fs.open(path.join(directory, '.write-lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new SecretError('store_busy'); throw error; }
    let result, failure;
    try { result = await action(); } catch (error) { failure = error; }
    // Preserve an action error; a cleanup failure after success is not a clean commit.
    for (const cleanup of [() => lock.close(), () => fs.unlink(path.join(directory, '.write-lock'))]) {
      try { await cleanup(); } catch { failure ??= new SecretError('commit_uncertain'); }
    }
    if (failure) throw failure;
    return result;
  }
  return Object.freeze({
    async init() {
      await privateDirectory(path.dirname(directory));
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await privateDirectory(directory);
      try { await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await checkRoot();
    },
    async read(name) { return (await record(name))?.value; },
    async describe(name) { const value = await record(name); return value ? metadata(name, value) : undefined; },
    async list() {
      await checkRoot();
      const result = [];
      for (const entry of (await fs.readdir(directory)).sort()) {
        if (!entry.endsWith('.json')) continue;
        const name = entry.slice(0, -5), value = await record(name);
        if (value) result.push(metadata(name, value));
      }
      return result;
    },
    async put(name, value) {
      location(name);
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 16384 || value.includes('\0')) throw new SecretError('invalid_value');
      return writeOperation(async () => {
        await record(name); // Refuse to replace a symlink, foreign owner, or malformed record.
        const next = { kind: 'secret-record', schema: 1, revision: randomUUID(), updatedAt: new Date().toISOString(), value };
        const serialized = JSON.stringify(next) + '\n';
        if (Buffer.byteLength(serialized) > MAX_RECORD) throw new SecretError('invalid_value');
        const temporary = path.join(directory, '.pending-' + randomUUID());
        let committed = false, handle, failure;
        try {
          handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = undefined;
          await fs.rename(temporary, location(name)); committed = true;
          await syncDirectory();
        } catch (error) { failure = committed ? new SecretError('commit_uncertain') : error; }
        try { await handle?.close(); } catch (error) { failure ??= error; }
        if (!committed) {
          try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
        }
        if (failure) throw failure;
        return metadata(name, next);
      });
    },
    async remove(name) {
      location(name);
      return writeOperation(async () => {
        if (!await record(name)) return { name, removed: false };
        await fs.unlink(location(name));
        try { await syncDirectory(); } catch { throw new SecretError('commit_uncertain'); }
        return { name, removed: true };
      });
    },
  });
}
