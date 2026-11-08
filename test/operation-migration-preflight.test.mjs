import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { migrateLegacyOperations } from '../src/adapters/storage/operation-migration.mjs';

const sources = ['command-automation.sqlite', 'agent-cli.sqlite'];
const hash = body => createHash('sha256').update(body).digest('hex');
const entry = (n, requestKey = 'synthetic:' + n) => {
  const job = { id: n.toString(16).padStart(48, '0'), state: 'completed', createdAt: n,
    operation: { kind: 'command', command: '합성 이력 😀' }, result: { text: '보존 🚀' } };
  return { job, requestKey, digest: hash(JSON.stringify(job)) };
};
function fixture(t, inventories) {
  const root = mkdtempSync(join(tmpdir(), 'portal-migration-preflight-'));
  const dataRoot = join(root, 'data'), archiveRoot = join(root, 'archive');
  mkdirSync(dataRoot, { mode: 0o700 });
  const originals = new Map();
  for (let index = 0; index < inventories.length; index++) {
    const path = join(dataRoot, sources[index]), db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, request_key TEXT UNIQUE);');
      const insert = db.prepare('INSERT INTO requests VALUES(?,?,?,?)');
      for (const { job, digest, requestKey } of inventories[index]) insert.run(job.id, JSON.stringify(job), digest, requestKey ?? null);
    } finally { db.close(); }
    originals.set(path, readFileSync(path));
  }
  const store = createOperationStore(dataRoot);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, dataRoot, archiveRoot, originals,
    migrate: () => migrateLegacyOperations({ legacyRoot: dataRoot, archiveRoot, store, now: 100 }) };
}
function unchangedSources(f) {
  for (const [path, bytes] of f.originals) assert.deepEqual(readFileSync(path), bytes);
}
function noNewEvidence(f, before, original) {
  assert.deepEqual(f.store.usage(), before.usage);
  assert.deepEqual(f.store.legacyUsage(), before.retained);
  if (original) {
    assert.deepEqual(f.store.get(original.id), original);
    assert.deepEqual(f.store.events(original.id), before.events);
  }
  assert.equal(existsSync(f.archiveRoot), false, 'identity preflight must finish before archiving');
  unchangedSources(f);
}

test('C18-01 cross-source request-key collisions reject the whole inventory before any canonical write', t => {
  const f = fixture(t, [[entry(1, 'shared-original-key')], [entry(2, 'shared-original-key')]]);
  const before = { usage: f.store.usage(), retained: f.store.legacyUsage() };
  assert.throws(f.migrate, { code: 'OPERATION_KEY_CONFLICT' });
  assert.equal(f.store.find('shared-original-key'), null);
  assert.equal(f.store.get(entry(1).job.id), null);
  assert.equal(f.store.get(entry(2).job.id), null);
  noNewEvidence(f, before);
});

test('C18-01 explicit keys cannot collide with another source default legacy key', t => {
  const first = entry(1, null), fallback = `legacy:${sources[0]}:${first.job.id}`;
  const f = fixture(t, [[first], [entry(2, fallback)]]);
  const before = { usage: f.store.usage(), retained: f.store.legacyUsage() };
  assert.throws(f.migrate, { code: 'OPERATION_KEY_CONFLICT' });
  assert.equal(f.store.find(fallback), null);
  noNewEvidence(f, before);
});

test('C18-02 cross-source operation ID collisions reject different original keys without partial import', t => {
  const first = entry(1), second = { ...entry(1, 'different-original-key'), digest: 'other-digest' };
  const f = fixture(t, [[first], [second]]);
  const before = { usage: f.store.usage(), retained: f.store.legacyUsage() };
  assert.throws(f.migrate, { code: 'OPERATION_KEY_CONFLICT' });
  assert.equal(f.store.get(first.job.id), null);
  assert.equal(f.store.find(first.requestKey), null);
  assert.equal(f.store.find(second.requestKey), null);
  noNewEvidence(f, before);
});

for (const conflict of ['key', 'id', 'original', 'digest', 'source']) {
  test(`C18-03 a late canonical ${conflict} conflict cannot commit an earlier 129-row source`, t => {
    const rows = Array.from({ length: 129 }, (_, n) => entry(n + 1)), last = entry(1000);
    const f = fixture(t, [rows, [last]]);
    const baseline = structuredClone(last);
    if (conflict === 'key') baseline.job.id = entry(1001).job.id;
    if (conflict === 'id') baseline.requestKey = 'different-original-key';
    if (conflict === 'original') baseline.job.result.text = 'different original evidence';
    if (conflict === 'digest') baseline.digest = 'different original digest';
    const original = f.store.importLegacy(baseline.job, {
      source: conflict === 'source' ? sources[0] : sources[1], requestKey: baseline.requestKey, digest: baseline.digest,
    });
    const before = { usage: f.store.usage(), retained: f.store.legacyUsage(), events: f.store.events(original.id) };
    const target = join(f.dataRoot, 'operations.sqlite'), bytes = readFileSync(target);
    assert.throws(f.migrate, { code: 'OPERATION_KEY_CONFLICT' });
    for (const { job, requestKey } of rows) {
      assert.equal(f.store.get(job.id), null);
      assert.equal(f.store.find(requestKey), null);
    }
    noNewEvidence(f, before, original);
    assert.deepEqual(readFileSync(target), bytes, 'preflight does not write an existing canonical database');
  });
}

test('C18-04 an exact partial import resumes without changing existing evidence or replaying work', t => {
  const first = entry(1), second = entry(2), third = entry(3);
  const f = fixture(t, [[first, second], [third]]);
  const original = f.store.importLegacy(first.job, { source: sources[0], requestKey: first.requestKey, digest: first.digest });
  const events = f.store.events(original.id), receipt = f.migrate();
  assert.equal(receipt.imported, 3);
  assert.equal(f.store.usage().count, 3);
  assert.deepEqual(f.store.get(original.id), original);
  assert.deepEqual(f.store.events(original.id), events);
  assert.equal(f.store.list({ state: 'queued' }).length, 0);
  for (const row of [first, second, third]) assert.deepEqual(f.store.find(row.requestKey).job.legacy.original, row.job);
  const before = { usage: f.store.usage(), retained: f.store.legacyUsage(), events: [first, second, third].map(row => f.store.events(row.job.id)) };
  assert.deepEqual(f.migrate(), receipt);
  assert.deepEqual(f.store.usage(), before.usage);
  assert.deepEqual(f.store.legacyUsage(), before.retained);
  assert.deepEqual([first, second, third].map(row => f.store.events(row.job.id)), before.events);
  unchangedSources(f);
  for (const [path, bytes] of f.originals) assert.deepEqual(readFileSync(join(f.archiveRoot, path.endsWith(sources[0]) ? sources[0] : sources[1])), bytes);
});

test('C18-05 Unicode original keys and evidence remain exact and distinct through preflight and rerun', t => {
  const first = entry(1, '문답:😀:é'), second = entry(2, '문답:😀:e\u0301');
  const f = fixture(t, [[first], [second]]);
  const receipt = f.migrate();
  assert.equal(receipt.imported, 2);
  for (const row of [first, second]) {
    assert.equal(f.store.find(row.requestKey).job.requestKey, row.requestKey);
    assert.deepEqual(f.store.find(row.requestKey).job.legacy.original, row.job);
  }
  const before = { usage: f.store.usage(), retained: f.store.legacyUsage(), events: [first, second].map(row => f.store.events(row.job.id)) };
  assert.deepEqual(f.migrate(), receipt);
  assert.deepEqual(f.store.usage(), before.usage);
  assert.deepEqual(f.store.legacyUsage(), before.retained);
  assert.deepEqual([first, second].map(row => f.store.events(row.job.id)), before.events);
  unchangedSources(f);
});
