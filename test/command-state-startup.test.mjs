import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';

function fixture(t, states) {
  const root = mkdtempSync(join(tmpdir(), 'command-state-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createCommandState(root).close();
  const path = join(root, 'command-automation.sqlite'), db = new DatabaseSync(path);
  const rows = states.map((state, index) => ({ id: `job-${index}`, request_key: `key-${index}`, digest: `digest-${index}`,
    body: JSON.stringify({ id: `job-${index}`, state, finishedAt: 123, result: { text: 'retained result' } }, null, 2) }));
  for (const row of rows) db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(row.id, row.request_key, row.digest, row.body);
  db.close();
  return { root, path, rows };
}
function stored(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT * FROM requests ORDER BY id').all().map(row => ({ ...row })); }
  finally { db.close(); }
}

test('startup never updates unchanged history and preserves its exact body, key and digest', t => {
  const f = fixture(t, ['completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown', 'accepted']);
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER reject_history_rewrite BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT,'unchanged history rewritten'); END;");
  const policy = db.prepare('SELECT * FROM policy').get(); db.close();
  const state = createCommandState(f.root);
  try { assert.equal(state.list().length, f.rows.length); } finally { state.close(); }
  assert.deepEqual(stored(f.path), f.rows);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { assert.deepEqual(check.prepare('SELECT * FROM policy').get(), policy); } finally { check.close(); }
});

test('startup normalizes only interrupted states and a second open performs no updates', t => {
  const f = fixture(t, ['queued', 'running', 'evaluating', 'pending', 'completed']);
  const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE writes (id TEXT); CREATE TRIGGER record_recovery AFTER UPDATE ON requests BEGIN INSERT INTO writes VALUES(new.id); END;');
  db.close();
  const before = Date.now(); createCommandState(f.root).close(); const after = Date.now();
  const first = stored(f.path);
  assert.deepEqual(first.map(row => JSON.parse(row.body).state), ['unknown', 'unknown', 'unknown', 'expired', 'completed']);
  for (const row of first.slice(0, 4)) {
    const job = JSON.parse(row.body);
    assert.ok(job.finishedAt >= before && job.finishedAt <= after);
    assert.deepEqual(job.result, { text: 'retained result' });
  }
  assert.deepEqual(first.map(({ id, request_key, digest }) => ({ id, request_key, digest })), f.rows.map(({ id, request_key, digest }) => ({ id, request_key, digest })));
  assert.equal(first[4].body, f.rows[4].body);
  createCommandState(f.root).close();
  assert.deepEqual(stored(f.path), first);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(check.prepare('SELECT count(*) AS n FROM writes').get().n, 4); } finally { check.close(); }
});

test('startup normalization rolls back every changed row if a later row fails', t => {
  const f = fixture(t, ['running', 'pending', 'completed']);
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON requests WHEN old.id='job-1' BEGIN SELECT RAISE(ABORT,'synthetic recovery failure'); END;");
  db.close();
  assert.throws(() => createCommandState(f.root), /synthetic recovery failure/);
  assert.deepEqual(stored(f.path), f.rows);
});
