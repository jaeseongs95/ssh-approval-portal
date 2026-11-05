import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readLegacyOperationHistory } from '../src/adapters/storage/operation-migration.mjs';

const runner = fileURLToPath(new URL('../scripts/deploy180.mjs', import.meta.url));
const source = 'command-automation.sqlite';
const hash = value => createHash('sha256').update(value).digest('hex');
// Object-mode buffers keep each byte as a separate async-iterator chunk. The
// real CLI still owns JSON parsing, store opening and migration comparison.
const splitStdin = 'data:text/javascript,' + encodeURIComponent(`
  import { readFileSync } from 'node:fs';
  import { Readable } from 'node:stream';
  const bytes = readFileSync(0);
  const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
  Object.defineProperty(process, 'stdin', { value: Readable.from(chunks), configurable: true });
`);
function invoke(mode, input) {
  const result = spawnSync(process.execPath, ['--import', splitStdin, runner, mode], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(result.error); assert.equal(result.signal, null);
  return { status: result.status, receipt: JSON.parse(result.stdout) };
}
function fixture(t, directory = 'data') {
  const root = mkdtempSync(join(tmpdir(), 'portal-migration-stdin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, directory), archiveRoot = join(root, 'archive');
  mkdirSync(dataRoot, { mode: 0o700 });
  const jobs = ['ASCII request', '한글 경계 보존', 'emoji 😀🚀'].map((text, index) => ({
    id: String(index + 1).repeat(48), state: 'completed', createdAt: 10 + index,
    finishedAt: 20 + index, operation: { kind: 'command', command: text }, result: { text },
  }));
  const path = join(dataRoot, source), db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, request_key TEXT UNIQUE);');
    const insert = db.prepare('INSERT INTO requests VALUES(?,?,?,?)');
    for (const job of jobs) insert.run(job.id, JSON.stringify(job), hash(JSON.stringify(job)), 'synthetic:' + job.id);
  } finally { db.close(); }
  return { dataRoot, archiveRoot, jobs, sourceBytes: readFileSync(path) };
}

test('migration-check preserves ASCII, Korean and emoji across one-byte stdin chunks', t => {
  const f = fixture(t);
  const imported = invoke('--migration-child', { legacyRoot: f.dataRoot, archiveRoot: f.archiveRoot });
  assert.equal(imported.status, 0); assert.equal(imported.receipt.imported, 3);
  const inventory = readLegacyOperationHistory(f.archiveRoot);
  assert.deepEqual(inventory[0].rows.map(row => row.job), f.jobs);
  const target = join(f.dataRoot, 'operations.sqlite'), before = readFileSync(target);
  const checked = invoke('--migration-check', { legacyRoot: f.dataRoot, inventory });
  assert.equal(checked.status, 0, JSON.stringify(checked.receipt));
  assert.deepEqual(checked.receipt, { type: 'portal.operation-migration-check.v1', status: 'completed' });
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(readFileSync(join(f.dataRoot, source)), f.sourceBytes);
  assert.deepEqual(readFileSync(join(f.archiveRoot, source)), f.sourceBytes);
});

test('migration-check still rejects genuinely changed original evidence with split stdin', t => {
  const f = fixture(t);
  assert.equal(invoke('--migration-child', { legacyRoot: f.dataRoot, archiveRoot: f.archiveRoot }).status, 0);
  const inventory = readLegacyOperationHistory(f.archiveRoot);
  inventory[0].rows[0].job.result.text = 'genuinely changed ASCII evidence';
  const target = join(f.dataRoot, 'operations.sqlite'), before = readFileSync(target);
  const checked = invoke('--migration-check', { legacyRoot: f.dataRoot, inventory });
  assert.equal(checked.status, 1); assert.equal(checked.receipt.code, 'OPERATION_KEY_CONFLICT');
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(readFileSync(join(f.archiveRoot, source)), f.sourceBytes);
});

test('migration-child preserves Korean and emoji in its stdin data-root path', t => {
  const f = fixture(t, 'data-한글-😀');
  const imported = invoke('--migration-child', { legacyRoot: f.dataRoot, archiveRoot: f.archiveRoot });
  assert.equal(imported.status, 0, JSON.stringify(imported.receipt));
  assert.equal(imported.receipt.imported, 3);
  const db = new DatabaseSync(join(f.dataRoot, 'operations.sqlite'), { readOnly: true });
  try {
    const original = db.prepare('SELECT body FROM operations ORDER BY id').all().map(row => JSON.parse(row.body).legacy.original);
    assert.deepEqual(original, f.jobs);
  } finally { db.close(); }
  assert.deepEqual(readFileSync(join(f.dataRoot, source)), f.sourceBytes);
});
