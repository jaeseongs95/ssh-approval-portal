import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { validateCommandPolicy } from '../../domain/command-policy.mjs';

/** Service-private SQLite journal; one bridge process owns the database at a time. */
export function createCommandState(root) {
  const path = join(root, 'command-automation.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.platform !== 'win32' && ((st.mode & 0o077) || st.uid !== process.getuid()))) throw Error('Unsafe command state');
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    db.exec('CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO policy VALUES (1,0,?)').run(JSON.stringify({ targets: [] }));
    for (const row of db.prepare('SELECT id,body FROM requests').all()) {
      const job = JSON.parse(row.body);
      if (['running', 'evaluating'].includes(job.state)) { job.state = 'unknown'; job.finishedAt = Date.now(); }
      else if (job.state === 'pending') { job.state = 'expired'; job.finishedAt = Date.now(); }
      db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify(job), row.id);
    }
  } catch (error) { db.close(); throw error; }
  const policy = () => { const row = db.prepare('SELECT revision,body FROM policy WHERE id=1').get(); return { revision: row.revision, ...validateCommandPolicy(JSON.parse(row.body)) }; };
  return {
    policy,
    preservationRows() {
      const usage = db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM requests').get();
      if (usage.count > 10000 || usage.bytes > 64 * 1024 * 1024) throw Error('Command preservation budget exceeded');
      return { schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
        policy: db.prepare('SELECT * FROM policy ORDER BY id').all(),
        requests: db.prepare('SELECT * FROM requests ORDER BY id').all() };
    },
    setPolicy(value, expectedRevision) {
      const body = JSON.stringify(validateCommandPolicy(value));
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Error('Policy revision required');
      const result = db.prepare('UPDATE policy SET body=?,revision=revision+1 WHERE id=1 AND revision=?').run(body, expectedRevision);
      if (result.changes !== 1) throw Error('Policy revision conflict');
      return policy();
    },
    find(key) { const row = db.prepare('SELECT digest,body FROM requests WHERE request_key=?').get(key); return row && { digest: row.digest, job: JSON.parse(row.body) }; },
    list() { return db.prepare('SELECT body FROM requests').all().map(row => JSON.parse(row.body)); },
    metricsRows(from,to) {
      // The journal is capped at 10,000 entries. Project metadata in SQLite, without loading command/context bodies.
      return db.prepare(`SELECT json_extract(body,'$.targetId') AS targetId,json_extract(body,'$.approvalMode') AS approvalMode,
        json_extract(body,'$.decision.reasonCode') AS reasonCode,json_extract(body,'$.decision.provider') AS provider,
        json_extract(body,'$.decision.assessment.status') = 'assessed' AS assessed,
        json_extract(body,'$.decision.assessment.inputTokens') AS inputTokens,json_extract(body,'$.decision.assessment.outputTokens') AS outputTokens,
        json_extract(body,'$.decision.evaluation.latencyMs') AS latencyMs,json_extract(body,'$.decision.attempts') AS attempts
        FROM requests WHERE json_extract(body,'$.createdAt')>=? AND json_extract(body,'$.createdAt')<=?`).all(from,to);
    },
    insert(job, key, digest) {
      // ponytail: bounded journal; explicit archival can replace this refusal when needed.
      if (db.prepare('SELECT count(*) AS n FROM requests').get().n >= 10000) throw Error('Command journal full');
      db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(job.id, key ?? null, digest, JSON.stringify(job));
    },
    save(job) {
      if (db.prepare('UPDATE requests SET body=? WHERE id=?').run(JSON.stringify(job), job.id).changes !== 1) throw Error('Missing command journal entry');
    },
    close() { db.close(); },
  };
}
