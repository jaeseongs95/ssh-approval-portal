import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** One private durable row; compare-and-set also fences other live state handles. */
export function createRuntimeCapacityState(root) {
  const path = join(root, 'capacity.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077))) throw Error('UNSAFE_CAPACITY_STORE');
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runtime_capacity (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);'); }
  catch (error) { db.close(); throw error; }
  const read = () => {
    const row = db.prepare('SELECT body FROM runtime_capacity WHERE id=1').get();
    return row ? JSON.parse(row.body) : null;
  };
  return {
    read,
    initialize(value) {
      db.prepare('INSERT OR IGNORE INTO runtime_capacity VALUES (1,?)').run(JSON.stringify(value));
      return read();
    },
    compareAndSet(expectedRevision, value) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (read()?.revision !== expectedRevision) throw Object.assign(Error('CAPACITY_REVISION_CONFLICT'), { code: 'CAPACITY_REVISION_CONFLICT' });
        db.prepare('UPDATE runtime_capacity SET body=? WHERE id=1').run(JSON.stringify(value));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
