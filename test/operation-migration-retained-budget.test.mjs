import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';

const sources = ['command-automation.sqlite', 'agent-cli.sqlite'];
const live = key => ({ requestKey: key, owner: 'owner', targetId: 'test', targetRevision: 'rev', kind: 'command', input: {} });
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'portal-retained-budget-'));
  let store = createOperationStore({ filePath: join(root, 'operations.sqlite'), ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = createOperationStore({ filePath: join(root, 'operations.sqlite'), ...options }); } };
}
const entry = n => ({ job: { id: n.toString(16).padStart(48, '0'), state: 'running', createdAt: n }, requestKey: 'legacy:' + n, digest: 'digest:' + n });

test('two accepted 10000-row sources remain visible beside live jobs and cannot consume live execution or storage slots', { timeout: 60000 }, t => {
  const f = fixture(t, { maxRows: 1 }), store = f.store;
  for (let sourceIndex = 0; sourceIndex < 2; sourceIndex++) {
    for (let offset = 0; offset < 10000; offset += 128) {
      store.importLegacyBatch(Array.from({ length: Math.min(128, 10000 - offset) }, (_, n) => entry(sourceIndex * 10000 + offset + n + 1)), { source: sources[sourceIndex] });
    }
  }
  assert.equal(store.list().length, 20000); assert.equal(store.legacyUsage().count, 20000);
  const before = store.legacyUsage();
  assert.throws(() => store.importLegacyBatch([entry(20001)], { source: sources[0] }), { code: 'LEGACY_HISTORY_CAPACITY' });
  assert.throws(() => store.importLegacyBatch([entry(20001)], { source: 'third-source' }), { code: 'LEGACY_HISTORY_CAPACITY' });
  assert.deepEqual(store.legacyUsage(), before);
  const job = store.accept(live('live-first')); store.update(job.id, { state: 'queued' });
  assert.equal(store.list().length, 20001); assert.equal(store.list({ state: 'queued' }).length, 1);
  assert.ok(store.claim(job.id, { unknownBudget: 1 }), 'historical unknown rows carry no dispatch authority');
  assert.throws(() => store.accept(live('live-second')), { code: 'OPERATION_CAPACITY' });
  f.reopen(); assert.equal(f.store.list().length, 20001); assert.deepEqual(f.store.legacyUsage(), before);
});

test('exact 256 KiB legacy entries survive expanded body/contract storage and retain their immutable evidence', t => {
  const f = fixture(t);
  for (const field of ['input', 'result']) {
    const job = { id: field.padEnd(48, '0'), state: 'completed', [field]: { text: '' } };
    job[field].text = 'x'.repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(job)));
    assert.equal(Buffer.byteLength(JSON.stringify(job)), 256 * 1024);
    const imported = f.store.importLegacy(job, { source: sources[0], requestKey: field, digest: field });
    assert.deepEqual(imported.legacy.original, job);
    assert.equal(f.store.legacyUsage().sources[0].originalBytes, (field === 'input' ? 1 : 2) * 256 * 1024);
    const updated = f.store.update(job.id, { result: { text: 'changed result' } });
    assert.deepEqual(updated.legacy.original, job);
    assert.throws(() => f.store.importLegacy(job, { source: sources[1], requestKey: field, digest: field }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.throws(() => f.store.importLegacy(job, { source: sources[0], requestKey: field + '-different-key', digest: field }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.throws(() => f.store.importLegacy({ ...job, id: 'different' }, { source: sources[0], requestKey: field, digest: field }), { code: 'OPERATION_KEY_CONFLICT' });
  }
  const before = f.store.legacyUsage(); f.reopen(); assert.deepEqual(f.store.legacyUsage(), before);
});

test('legacy result growth charges the live byte budget exactly and shrinking restores it without enlarging reservations', t => {
  const f = fixture(t, { maxBytes: 2048, now: () => 100 }), store = f.store;
  const job = { id: 'b'.repeat(48), state: 'completed', result: { text: 'x'.repeat(2048) } };
  store.importLegacy(job, { source: sources[0] });
  const before = store.usage(), retained = store.legacyUsage();
  store.update(job.id, { result: { text: 'x'.repeat(4096) } });
  assert.equal(store.usage().bytes - before.bytes, 2048);
  assert.deepEqual(store.legacyUsage(), retained);
  assert.throws(() => store.accept(live('blocked-by-result-growth')), { code: 'OPERATION_CAPACITY' });
  store.update(job.id, { result: job.result });
  assert.deepEqual(store.usage(), before); assert.deepEqual(store.legacyUsage(), retained);
  assert.ok(store.accept(live('after-result-shrink')));
});

test('a legacy shrink cannot fund another row, while each original baseline and aggregate live growth remain available', t => {
  const f = fixture(t, { maxBytes: 2048, now: () => 100 }), store = f.store;
  const make = (id, size) => ({ id: id.repeat(48), state: 'completed', result: { text: 'x'.repeat(size) } });
  const a = make('a', 8192), b = make('b', 4096);
  store.importLegacy(a, { source: sources[0] }); store.importLegacy(b, { source: sources[0] });
  const reserved = store.legacyUsage();
  store.update(a.id, { result: { text: '' } });
  assert.throws(() => store.accept({ ...live('cannot-use-history-slack'), input: { text: 'x'.repeat(3000) } }), { code: 'OPERATION_CAPACITY' });
  store.update(a.id, { result: a.result });
  store.update(a.id, { result: { text: 'x'.repeat(9216) } });
  store.update(b.id, { result: { text: 'x'.repeat(5120) } });
  assert.throws(() => store.update(b.id, { result: { text: 'x'.repeat(5121) } }), { code: 'OPERATION_CAPACITY' });
  assert.deepEqual(store.legacyUsage(), reserved);
  f.reopen(); assert.deepEqual(f.store.legacyUsage(), reserved);
  assert.throws(() => f.store.accept(live('still-at-live-byte-limit')), { code: 'OPERATION_CAPACITY' });
  f.store.update(a.id, { result: a.result });
  assert.ok(f.store.accept(live('within-live-byte-limit')));
});

test('missing old reservations never turn a modified import projection into a free baseline', t => {
  const root = mkdtempSync(join(tmpdir(), 'portal-invalid-import-baseline-')), path = join(root, 'operations.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createOperationStore(root), job = { id: 'c'.repeat(48), state: 'completed', result: { text: 'original' } };
  const imported = store.importLegacy(job, { source: sources[0] }); store.close();
  const changed = JSON.stringify({ ...imported, result: { text: 'runtime expansion without an original reservation' } });
  const db = new DatabaseSync(path);
  try { db.exec('DROP TABLE operation_legacy_budget'); db.prepare('UPDATE operations SET body=? WHERE id=?').run(changed, job.id); }
  finally { db.close(); }
  assert.throws(() => createOperationStore(root), { code: 'INVALID_LEGACY_IMPORT_BASELINE' });
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT body FROM operations WHERE id=?').get(job.id).body, changed);
    assert.equal(check.prepare('SELECT count(*) AS n FROM operation_legacy_budget').get().n, 0);
  } finally { check.close(); }
});
