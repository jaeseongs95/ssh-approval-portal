import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { readLegacyOperationHistory } from '../src/adapters/storage/operation-migration.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const runner = fileURLToPath(new URL('../scripts/deploy180.mjs', import.meta.url));
const source = 'command-automation.sqlite';
const row = n => ({ job: { id: n.toString(16).padStart(48, '0'), state: n % 11 ? 'completed' : 'running',
  createdAt: n, operation: { kind: 'command', command: 'synthetic-only' }, result: { text: 'x'.repeat(2048) } },
  requestKey: 'synthetic:' + n, digest: 'digest:' + n });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'portal-migration-batch-'));
  const dataRoot = join(root, 'data'); mkdirSync(dataRoot, { mode: 0o700 });
  t.after(() => { if (process.env.PORTAL_KEEP_MIGRATION_FIXTURES === '1') t.diagnostic(JSON.stringify({ preservedSyntheticFixture: root })); else rmSync(root, { recursive: true, force: true }); });
  return { root, dataRoot };
}

test('8000 synthetic legacy rows migrate within the existing 60-second child boundary, preserve bytes, and recheck idempotently', { timeout: 150000 }, t => {
  const { root, dataRoot } = fixture(t), archiveRoot = join(root, 'archive'), path = join(dataRoot, source);
  const count = 8000, seedStart = performance.now(), db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, request_key TEXT UNIQUE); BEGIN;');
    const insert = db.prepare('INSERT INTO requests VALUES(?,?,?,?)');
    for (let n = 1; n <= count; n++) { const { job, digest, requestKey } = row(n); insert.run(job.id, JSON.stringify(job), digest, requestKey); }
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = hash(readFileSync(path)), readStart = performance.now();
  const inventory = readLegacyOperationHistory(dataRoot), readMs = performance.now() - readStart;
  const started = performance.now();
  const child = spawnSync(process.execPath, [runner, '--migration-child'], { input: JSON.stringify({ legacyRoot: dataRoot, archiveRoot }), encoding: 'utf8', timeout: 60000 });
  const elapsedMs = performance.now() - started;
  t.diagnostic(JSON.stringify({ rows: count, legacyBytes: statSync(path).size, seedMs: readStart - seedStart, readMs, childMs: elapsedMs,
    childStatus: child.status, childError: child.error?.code ?? null, journalBytes: statSync(join(dataRoot, 'operations.sqlite')).size }));
  assert.ifError(child.error); assert.equal(child.status, 0, child.stdout);
  const receipt = JSON.parse(child.stdout);
  assert.equal(receipt.imported, count); assert.equal(receipt.unknown, Math.floor(count / 11));
  assert.equal(hash(readFileSync(path)), before); assert.equal(hash(readFileSync(join(archiveRoot, source))), before);
  const store = createOperationStore(dataRoot);
  try {
    assert.equal(store.usage().count, count);
    assert.equal(store.find('synthetic:11').job.state, 'unknown');
    assert.deepEqual(store.find('synthetic:8000').job.legacy.original, row(8000).job);
  } finally { store.close(); }
  const checkStart = performance.now();
  const check = spawnSync(process.execPath, [runner, '--migration-check'], { input: JSON.stringify({ legacyRoot: dataRoot, inventory }), encoding: 'utf8', timeout: 60000 });
  t.diagnostic(JSON.stringify({ recheckMs: performance.now() - checkStart, childStatus: check.status, childError: check.error?.code ?? null }));
  assert.ifError(check.error); assert.equal(check.status, 0, check.stdout);
  assert.equal(hash(readFileSync(path)), before);
});

test('batch failures preserve earlier imports and exact retained/live byte and row budgets across reopen', t => {
  const { dataRoot } = fixture(t), options = { filePath: join(dataRoot, 'operations.sqlite'), maxRows: 1, maxBytes: 2048 };
  let store = createOperationStore(options);
  try {
    const first = store.importLegacy(row(1).job, { source, ...row(1) });
    const before = store.usage(), retained = store.legacyUsage();
    assert.throws(() => store.importLegacyBatch([row(2), { ...row(1), digest: 'conflict' }], { source }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.deepEqual(store.usage(), before); assert.deepEqual(store.legacyUsage(), retained); assert.deepEqual(store.get(first.id), first);
    assert.equal(store.find('synthetic:2'), null);
    const second = store.importLegacyBatch([row(2), row(3)], { source });
    assert.equal(second.length, 2); assert.equal(store.usage().count, 3);
    const committed = store.usage(), reserved = store.legacyUsage();
    assert.throws(() => store.importLegacyBatch([row(4), { ...row(2), digest: 'conflict' }], { source }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.deepEqual(store.usage(), committed); assert.deepEqual(store.legacyUsage(), reserved); assert.equal(store.find('synthetic:4'), null);
    assert.deepEqual(store.importLegacyBatch([row(1), row(2), row(3)], { source }), [first, ...second]);
    assert.deepEqual(store.usage(), committed);
    assert.deepEqual(store.legacyUsage(), reserved);
    assert.throws(() => store.update(first.id, { result: { text: 'y'.repeat(8192) } }), { code: 'OPERATION_CAPACITY' });
    assert.deepEqual(store.usage(), committed); assert.deepEqual(store.get(first.id), first);
    assert.throws(() => store.update(first.id, { legacy: { ...first.legacy, source: 'changed' } }), { code: 'OPERATION_CONTRACT_IMMUTABLE' });
    store.close(); store = createOperationStore(options);
    assert.deepEqual(store.usage(), committed); assert.deepEqual(store.legacyUsage(), reserved);
    assert.equal(store.list().length, 3, 'retained rows are not truncated by the live maxRows');
    const live = { requestKey: 'live-one', owner: 'owner', targetId: 'test', targetRevision: 'rev', kind: 'command', input: {} };
    store.accept(live); assert.equal(store.usage().count, 4);
    assert.throws(() => store.accept({ ...live, requestKey: 'live-two' }), { code: 'OPERATION_CAPACITY' });
  } finally { store.close(); }
});

test('a pre-budget partial import with a hot SQLite journal reopens without losing original history or charging live allowance', t => {
  const { dataRoot } = fixture(t), path = join(dataRoot, 'operations.sqlite');
  let store = createOperationStore(dataRoot);
  const original = store.importLegacy(row(11).job, { source, ...row(11) }), events = store.events(original.id);
  store.close();
  const db = new DatabaseSync(path); db.exec('DROP TABLE operation_legacy_budget'); db.close();
  const code = `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE'); db.prepare('UPDATE operations SET body=?').run('x'.repeat(100000)); process.kill(process.pid, 'SIGKILL');`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', code, path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(killed.signal, 'SIGKILL'); assert.ok(statSync(path + '-journal').size > 0);
  store = createOperationStore(dataRoot);
  try {
    assert.deepEqual(store.get(original.id), original); assert.deepEqual(store.events(original.id), events);
    assert.equal(store.legacyUsage().count, 1); assert.equal(store.legacyUsage().bytes, store.usage().bytes);
    const before = store.legacyUsage();
    store.importLegacyBatch([row(11)], { source }); assert.deepEqual(store.legacyUsage(), before);
  } finally { store.close(); }
});

test('accepted 30 MiB original history may expand beyond 64 MiB without consuming the separate live budget', { timeout: 150000 }, t => {
  const { root, dataRoot } = fixture(t), path = join(dataRoot, source), count = 5000, db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, request_key TEXT UNIQUE); BEGIN;');
    const insert = db.prepare('INSERT INTO requests VALUES(?,?,?,?)');
    for (let n = 1; n <= count; n++) {
      const entry = row(n); entry.job.result = { text: 'synthetic' }; entry.job.operation.command = 'x'.repeat(6000);
      insert.run(entry.job.id, JSON.stringify(entry.job), entry.digest, entry.requestKey);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = hash(readFileSync(path)), started = performance.now();
  const child = spawnSync(process.execPath, [runner, '--migration-child'], { input: JSON.stringify({ legacyRoot: dataRoot, archiveRoot: join(root, 'archive') }), encoding: 'utf8', timeout: 60000 });
  t.diagnostic(JSON.stringify({ kind: 'near-original-budget', rows: count, legacyFileBytes: statSync(path).size, childMs: performance.now() - started, childStatus: child.status, childError: child.error?.code ?? null }));
  assert.ifError(child.error); assert.equal(child.status, 0, child.stdout);
  const receipt = JSON.parse(child.stdout), store = createOperationStore(dataRoot);
  try {
    assert.equal(receipt.imported, count); assert.ok(store.usage().bytes > 64 * 1024 * 1024);
    const reserved = store.legacyUsage(); assert.equal(reserved.count, count); assert.equal(reserved.bytes, store.usage().bytes);
    assert.ok(reserved.sources[0].originalBytes < 64 * 1024 * 1024);
    const record = { requestKey: 'new-after-history', owner: 'owner', targetId: 'test', targetRevision: 'rev', kind: 'command', input: {} };
    assert.ok(store.accept(record)); assert.deepEqual(store.legacyUsage(), reserved);
    assert.equal(store.claim(row(11).job.id), null, 'historical unknown never acquires execution authority');
    assert.equal(hash(readFileSync(path)), before);
  } finally { store.close(); }
});

test('batch verification rejects missing and conflicting evidence without adding rows or events', t => {
  const { dataRoot } = fixture(t), store = createOperationStore(dataRoot);
  try {
    store.importLegacyBatch([row(1), row(2)], { source });
    const before = store.usage(), events = store.events(row(1).job.id);
    assert.throws(() => store.importLegacyBatch([row(1), row(3)], { source, requireExisting: true }), { code: 'LEGACY_MIGRATION_RECORD_MISSING' });
    assert.throws(() => store.importLegacyBatch([{ ...row(1), job: { ...row(1).job, state: 'failed' } }], { source, requireExisting: true }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.deepEqual(store.usage(), before); assert.deepEqual(store.events(row(1).job.id), events);
    assert.equal(store.get(row(3).job.id), null);
    assert.throws(() => store.importLegacyBatch(Array.from({ length: 129 }, (_, n) => row(n + 10)), { source }), { code: 'INVALID_LEGACY_BATCH' });
    assert.deepEqual(store.usage(), before);
  } finally { store.close(); }
});
