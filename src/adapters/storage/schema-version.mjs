import {DatabaseSync} from 'node:sqlite';

/** The service accepts only explicit v1 state; legacy conversion is an offline operation. */
export const STORAGE_SCHEMA_VERSION = 1;
export function requireStorageVersion(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== STORAGE_SCHEMA_VERSION) throw Error('State schema requires explicit offline migration');
}
export function initializeStorageSchema(db, created, sql) {
  if (!created) {
    requireStorageVersion(db);
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(sql);
      const schema = connection => JSON.stringify(connection.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all());
      if (schema(db) !== schema(expected)) throw Error('Unsupported state schema');
      const result = db.prepare('PRAGMA quick_check').all();
      if (result.length !== 1 || result[0].quick_check !== 'ok') throw Error('Corrupt state schema');
    } finally { expected.close(); }
    return;
  }
  db.exec('BEGIN EXCLUSIVE');
  try {
    db.exec(sql);
    db.exec('PRAGMA user_version=1; COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
