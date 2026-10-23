import { constants } from 'node:fs';
import { lstat, open, mkdtemp, unlink, rmdir, link } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { CHUNK_BYTES, MAX_BYTES } from '../../contracts/ports.mjs';

const fail = code => Object.assign(new Error(code), { code });
function localPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 4096) throw fail('INVALID_LOCAL_PATH');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':') ||
      value.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw fail('INVALID_LOCAL_PATH');
  return value;
}
export { localPath as validateLocalPath };
function limit(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BYTES) throw fail('INVALID_LOCAL_LIMIT');
}
const sameFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function writeAll(fd, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw fail('INCOMPLETE_LOCAL_WRITE');
    offset += bytesWritten;
  }
}
async function removeOwned(file, directory) {
  if (file) await unlink(file);
  if (directory) await rmdir(directory);
}

/** Captures bytes before handing them to a transport. Callback/stream lifetime is bounded
 * by this call; no staging path, source contents, credentials or network operations escape.
 * Caller owns the source and staging parent. This is not a same-UID/root sandbox. */
export async function withUploadSnapshot(sourcePath, consume, { maxBytes = MAX_BYTES, signal, stagingRoot = tmpdir() } = {}) {
  localPath(sourcePath); localPath(stagingRoot); limit(maxBytes);
  if (typeof consume !== 'function') throw fail('INVALID_SNAPSHOT_CONSUMER');
  signal?.throwIfAborted();
  const beforePath = await lstat(sourcePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > BigInt(maxBytes)) throw fail('INVALID_LOCAL_SOURCE');
  let source, copy, directory, file, closed = false, reading = false;
  try {
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await source.stat({ bigint: true });
    if (!sameFile(beforePath, before)) throw fail('LOCAL_SOURCE_CHANGED');
    directory = await mkdtemp(join(stagingRoot, 'ssh-approval-upload-'));
    const copyPath = join(directory, 'snapshot');
    copy = await open(copyPath, 'wx+', 0o600); file = copyPath;
    const digest = createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (size + bytesRead > maxBytes) throw fail('LOCAL_SOURCE_CHANGED');
      const bytes = buffer.subarray(0, bytesRead);
      await writeAll(copy, bytes); digest.update(bytes); size += bytesRead;
    }
    const after = await source.stat({ bigint: true }), afterPath = await lstat(sourcePath, { bigint: true });
    if (BigInt(size) !== before.size || !sameFile(before, after) || !sameFile(before, afterPath)) throw fail('LOCAL_SOURCE_CHANGED');
    await source.close(); source = null;
    signal?.throwIfAborted();
    const snapshot = Object.freeze({ fileName: basename(sourcePath), size, sha256: digest.digest('hex'),
      async *chunks() {
        if (closed || reading) throw fail('SNAPSHOT_UNAVAILABLE');
        reading = true;
        try {
          for (let position = 0; position < size;) {
            if (closed) throw fail('SNAPSHOT_UNAVAILABLE');
            signal?.throwIfAborted();
            const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
            const { bytesRead } = await copy.read(bytes, 0, bytes.length, position);
            if (!bytesRead) throw fail('INCOMPLETE_SNAPSHOT');
            position += bytesRead;
            yield bytes.subarray(0, bytesRead);
          }
        } finally { reading = false; }
      },
    });
    return await consume(snapshot);
  } finally {
    closed = true;
    try { await source?.close(); }
    finally { try { await copy?.close(); } finally { await removeOwned(file, directory); } }
  }
}

/** Writes an authenticated transport's bytes, not a URL. The caller owns and must abort
 * the producer too. No retries, directory creation, overwrite or filename inference.
 * Hard-link publication is exclusive; unsupported filesystems fail closed. File sync
 * precedes publication, but power-loss durability and hostile ancestor swaps are not promised. */
export async function saveDownload(destination, { size, sha256 }, chunks, { maxBytes = MAX_BYTES, signal } = {}) {
  localPath(destination); limit(maxBytes); signal?.throwIfAborted();
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw fail('INVALID_DOWNLOAD_METADATA');
  let directory, file, fd, published = false, cleanupError;
  try {
    directory = await mkdtemp(join(dirname(destination), '.ssh-approval-download-'));
    const copyPath = join(directory, 'verified');
    fd = await open(copyPath, 'wx', 0o600); file = copyPath;
    const digest = createHash('sha256');
    let received = 0;
    for await (const bytes of chunks) {
      signal?.throwIfAborted();
      if (!(bytes instanceof Uint8Array) || bytes.length > CHUNK_BYTES || received + bytes.length > size) throw fail('INVALID_DOWNLOAD_BYTES');
      // Producers may reuse their buffer while the asynchronous write is pending.
      const owned = Buffer.from(bytes);
      if (owned.length > CHUNK_BYTES || received + owned.length > size) throw fail('INVALID_DOWNLOAD_BYTES');
      await writeAll(fd, owned); digest.update(owned); received += owned.length;
    }
    signal?.throwIfAborted();
    if (received !== size || digest.digest('hex') !== sha256) throw fail('DOWNLOAD_INTEGRITY_MISMATCH');
    await fd.sync(); await fd.close(); fd = null;
    signal?.throwIfAborted();
    await link(file, destination); // Linearization point: never replaces an existing entry.
    published = true;
  } finally {
    try { await fd?.close(); }
    finally {
      try { await removeOwned(file, directory); }
      catch (error) { if (!published) throw error; cleanupError = error; }
    }
  }
  // Cancellation/cleanup after publication must not turn a saved file into a reported failure.
  return Object.freeze({ state: 'saved', size, sha256, cleanupPending: Boolean(cleanupError) });
}
