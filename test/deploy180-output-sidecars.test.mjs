import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm, symlink, link, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { durableFingerprint, runDeployment } from '../scripts/deploy180.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'portal-output-sidecars-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data'), outputs = join(dataRoot, 'command-outputs');
  await mkdir(outputs, { recursive: true, mode: 0o700 });
  return { root, dataRoot, outputs };
}

test('a normal persistent SQLite output journal remains fingerprintable after clean database close', async t => {
  const { dataRoot, outputs } = await fixture(t), database = join(outputs, 'manifest.sqlite');
  const db = new DatabaseSync(database);
  try { db.exec('PRAGMA journal_mode=PERSIST; CREATE TABLE fixture(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO fixture(body) VALUES(\'retained\');'); }
  finally { db.close(); }
  const journal = join(outputs, 'manifest.sqlite-journal'), journalStat = await stat(journal);
  assert.equal(journalStat.isFile(), true); assert.ok(journalStat.size > 0);
  const before = await readFile(journal);
  assert.match(await durableFingerprint(dataRoot), /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(journal), before, 'fingerprinting must preserve the persistent journal bytes');
});

test('all three output manifest sidecars participate in the hash even with unchanged size and timestamp', async t => {
  const { dataRoot, outputs } = await fixture(t), fixed = new Date('2020-01-01T00:00:00Z');
  await writeFile(join(outputs, 'manifest.sqlite'), 'fixture-manifest');
  for (const suffix of ['journal', 'wal', 'shm']) {
    const file = join(outputs, 'manifest.sqlite-' + suffix);
    await writeFile(file, Buffer.alloc(33344, 1)); await utimes(file, fixed, fixed);
    const beforeStat = await stat(file, { bigint: true }), baseline = await durableFingerprint(dataRoot);
    await writeFile(file, Buffer.alloc(33344, 2)); await utimes(file, fixed, fixed);
    const afterStat = await stat(file, { bigint: true });
    assert.equal(afterStat.size, beforeStat.size); assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
    assert.notEqual(await durableFingerprint(dataRoot), baseline, suffix + ' byte changes must cross the recovery barrier');
  }
  for (const name of ['manifest.sqlite-backup', 'manifest.sqlite-journal-extra', 'other.sqlite-wal']) {
    const file = join(outputs, name); await writeFile(file, 'unknown');
    await assert.rejects(durableFingerprint(dataRoot), { code: 'UNSUPPORTED_DURABLE_DATA' });
    await rm(file);
  }
});

test('output sidecar links remain refused', { skip: process.platform === 'win32' }, async t => {
  const { root, dataRoot, outputs } = await fixture(t), source = join(root, 'outside');
  const journal = join(outputs, 'manifest.sqlite-journal'); await writeFile(source, 'original');
  await symlink(source, journal);
  await assert.rejects(durableFingerprint(dataRoot), { code: 'UNSAFE_DEPLOY_DATA' });
  await rm(journal); await link(source, journal);
  await assert.rejects(durableFingerprint(dataRoot), { code: 'UNSUPPORTED_DURABLE_DATA' });
  assert.equal(await readFile(source, 'utf8'), 'original');
});

test('an output journal write forbids downmigration and retains the selected release and every fixture byte', { skip: process.platform === 'win32' }, async t => {
  const { root, dataRoot, outputs } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
  const release = join(appRoot, 'releases', generation), previousRelease = join(appRoot, 'releases', 'previous');
  await mkdir(appRoot, { mode: 0o700 }); await mkdir(release, { recursive: true }); await mkdir(previousRelease);
  await mkdir(join(appRoot, 'deployments'), { mode: 0o700 });
  const activePath = join(appRoot, 'approval-bridge'); await symlink(release, activePath);
  const plan = { generation, sourceDir: join(root, 'unused-source'), appRoot, activePath, dataRoot,
    healthUrl: 'http://127.0.0.1:39999/health', service: { stop: [process.execPath, '-e', 'process.exit(0)'],
      start: [process.execPath, '-e', 'process.exit(0)'], status: [process.execPath, '-e', 'process.exit(3)'] } };
  const operation = join(dataRoot, 'operations.sqlite'), journal = join(outputs, 'manifest.sqlite-journal');
  await writeFile(operation, 'unchanged-operations'); await writeFile(journal, 'journal-baseline');
  const baseline = await durableFingerprint(dataRoot), planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  await writeFile(join(appRoot, 'deployments', generation + '.json'), JSON.stringify({ planHash, generation, phase: 'activated', previousRelease, baseline }));
  await writeFile(journal, 'journal-new-write');
  await assert.rejects(runDeployment('recover', plan), { code: 'DOWNMIGRATION_FORBIDDEN_AFTER_WRITES' });
  assert.equal(await readlink(activePath), release);
  assert.equal(await readFile(operation, 'utf8'), 'unchanged-operations');
  assert.equal(await readFile(journal, 'utf8'), 'journal-new-write');
});
