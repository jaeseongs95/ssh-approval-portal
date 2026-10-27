import { createHash } from 'node:crypto';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// One live bridge owns this database. Reservation survives process replacement.
export function createMaintenanceState(root) {
  const path = join(root, 'maintenance.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw Error('Unsafe maintenance state');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; CREATE TABLE IF NOT EXISTS reservation (id INTEGER PRIMARY KEY CHECK(id=1), owner_hash TEXT NOT NULL, baseline TEXT);');
  } catch (error) { db.close(); throw error; }
  const digest = owner => {
    if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) throw Error('Valid maintenance owner required');
    return createHash('sha256').update(owner, 'utf8').digest('hex');
  };
  const current = () => db.prepare('SELECT owner_hash FROM reservation WHERE id=1').get()?.owner_hash;
  return {
    occupied: () => current() !== undefined,
    owns: owner => current() === digest(owner),
    reserve(owner) { db.prepare('INSERT INTO reservation (id,owner_hash) VALUES (1,?)').run(digest(owner)); },
    saveBaseline(owner, baseline) {
      const body = JSON.stringify(baseline);
      if (Buffer.byteLength(body, 'utf8') > 4 * 1024 * 1024) throw Error('Preservation baseline too large');
      if (db.prepare('UPDATE reservation SET baseline=? WHERE id=1 AND owner_hash=? AND baseline IS NULL').run(body, digest(owner)).changes !== 1) throw Error('Preservation baseline already exists or ownership mismatch');
    },
    baseline(owner) {
      const row = db.prepare('SELECT baseline FROM reservation WHERE id=1 AND owner_hash=?').get(digest(owner));
      if (!row) throw Error('Maintenance ownership mismatch');
      return row.baseline ? JSON.parse(row.baseline) : null;
    },
    release(owner) { if (db.prepare('DELETE FROM reservation WHERE id=1 AND owner_hash=?').run(digest(owner)).changes !== 1) throw Error('Maintenance ownership mismatch'); },
    close: () => db.close(),
  };
}
