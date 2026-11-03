import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, chmodSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const sources = ['command-automation.sqlite', 'agent-cli.sqlite'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const regular = path => {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('UNSAFE_LEGACY_FILE');
  return st;
};

function readSource(path) {
  regular(path);
  // A live/unclean legacy writer must be stopped, never opened through its mutating adapter.
  if (['-wal', '-journal'].some(suffix => existsSync(path + suffix))) fail('LEGACY_NOT_QUIESCENT');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON;');
    const columns = db.prepare('PRAGMA table_info(requests)').all().map(row => row.name);
    if (!['id', 'body', 'digest'].every(name => columns.includes(name))) fail('UNSUPPORTED_LEGACY_SCHEMA');
    const usage = db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM requests').get();
    if (usage.n > 10000 || usage.bytes > 64 * 1024 * 1024) fail('LEGACY_HISTORY_CAPACITY');
    const requestKeyColumn = columns.includes('request_key') ? 'request_key' : 'NULL AS request_key';
    return db.prepare(`SELECT id,body,digest,${requestKeyColumn} FROM requests ORDER BY id`).all().map(row => {
      if (typeof row.body !== 'string' || typeof row.digest !== 'string') fail('INVALID_LEGACY_HISTORY');
      if (row.request_key !== null && (typeof row.request_key !== 'string' || !row.request_key)) fail('INVALID_LEGACY_REQUEST_KEY');
      if (Buffer.byteLength(row.body) > 256 * 1024) fail('LEGACY_ENTRY_TOO_LARGE');
      let job; try { job = JSON.parse(row.body); } catch { fail('INVALID_LEGACY_HISTORY'); }
      if (typeof job?.id !== 'string' || job.id !== row.id || typeof job.state !== 'string') fail('INVALID_LEGACY_HISTORY');
      return { job, digest: row.digest, requestKey: row.request_key ?? undefined };
    });
  } finally { db.close(); }
}

/** No legacy adapters, executors, policy writes or output GC are invoked here. */
export function readLegacyOperationHistory(legacyRoot) {
  const root = lstatSync(legacyRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) fail('UNSAFE_LEGACY_ROOT');
  return sources.filter(source => existsSync(join(legacyRoot, source))).map(source => {
    const path = join(legacyRoot, source);
    if (regular(path).size > 128 * 1024 * 1024) fail('LEGACY_HISTORY_CAPACITY');
    const before = hash(readFileSync(path));
    const rows = readSource(path);
    if (before !== hash(readFileSync(path))) fail('LEGACY_CHANGED_DURING_READ');
    return { source, sha256: before, rows };
  });
}

export function migrateLegacyOperations({ legacyRoot, archiveRoot, store, now = Date.now() }) {
  if (resolve(legacyRoot) === resolve(archiveRoot) || typeof store?.importLegacy !== 'function') fail('INVALID_MIGRATION_TARGET');
  const inventory = readLegacyOperationHistory(legacyRoot);
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(archiveRoot).isDirectory() || lstatSync(archiveRoot).isSymbolicLink()) fail('UNSAFE_LEGACY_ARCHIVE');
  const receipt = { type: 'portal.operation-migration.v1', at: now, sources: [], imported: 0, unknown: 0,
    outputRetention: { ttlMs: 3600000, action: 'preserve-existing-files-and-expiry',
      unavailable: 'Expired, previously deleted, or never durably captured output cannot be reconstructed. History is retained; never replay an operation to recreate output.' },
    volatileTransfers: 'Legacy transfer metadata existed only in memory; archived history does not resume those transfer IDs.' };
  // Archive all sources before the first target write; reruns require identical original bytes.
  for (const { source, sha256 } of inventory) {
    const original = join(legacyRoot, source), archive = join(archiveRoot, source);
    const created = !existsSync(archive);
    if (created) copyFileSync(original, archive, constants.COPYFILE_EXCL);
    regular(archive);
    if (hash(readFileSync(archive)) !== sha256 || hash(readFileSync(original)) !== sha256) fail('LEGACY_ARCHIVE_MISMATCH');
    // Windows FlushFileBuffers needs a writable handle; flush before making the archive readonly.
    if (created) { const fd = openSync(archive, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    chmodSync(archive, 0o400);
  }
  if (process.platform !== 'win32') {
    const fd = openSync(archiveRoot, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  for (const { source, sha256, rows } of inventory) {
    let unknown = 0;
    for (const { job, digest, requestKey } of rows) {
      store.importLegacy(job, { source, digest, requestKey });
      if (!terminal.has(job.state) || job.state === 'unknown') unknown++;
    }
    if (hash(readFileSync(join(legacyRoot, source))) !== sha256) fail('LEGACY_CHANGED_DURING_IMPORT');
    receipt.sources.push({ source, sha256, imported: rows.length, unknown, archiveMode: '0400' });
    receipt.imported += rows.length; receipt.unknown += unknown;
  }
  return receipt;
}
