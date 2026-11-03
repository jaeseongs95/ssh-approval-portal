import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { migrateLegacyOperations, readLegacyOperationHistory } from '../src/adapters/storage/operation-migration.mjs';
import { durableFingerprint, runDeployment } from '../scripts/deploy180.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'portal-migration-180-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data'); await mkdir(dataRoot, { mode: 0o700 });
  return { root, dataRoot };
}
function legacy(path, jobs) {
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY,body TEXT,digest TEXT,request_key TEXT); CREATE TABLE policy(id INTEGER,revision INTEGER,body TEXT);');
    db.prepare('INSERT INTO policy VALUES(1,7,?)').run('{"targets":[]}');
    for (const job of jobs) db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(job.id, JSON.stringify(job), hash(JSON.stringify(job)), job.requestKey ?? 'original:' + job.id);
  } finally { db.close(); }
}

test('migration retains exact history/policies and source bytes, archives readonly, and never queues legacy work', async t => {
  const { root, dataRoot } = await fixture(t), path = join(dataRoot, 'command-automation.sqlite');
  const completed = { id: 'a'.repeat(48), state: 'completed', command: 'printf preserved', createdAt: 10, finishedAt: 20, result: { output: { id: 'c'.repeat(48), expiresAt: 21 } } };
  const running = { id: 'b'.repeat(48), state: 'running', createdAt: 12 };
  legacy(path, [completed, running]);
  const before = await readFile(path), store = createOperationStore(dataRoot), archiveRoot = join(root, 'archive');
  try {
    const receipt = migrateLegacyOperations({ legacyRoot: dataRoot, archiveRoot, store, now: 100 });
    assert.equal(receipt.imported, 2); assert.equal(receipt.unknown, 1);
    assert.equal(receipt.sources[0].sha256, hash(before));
    assert.deepEqual(store.get(completed.id).legacy.original, completed);
    assert.equal(store.find('original:' + completed.id).job.id, completed.id);
    assert.equal(store.get(completed.id).state, 'completed');
    assert.equal(store.get(running.id).state, 'unknown');
    assert.equal(store.get(running.id).requiresReconciliation, true);
    assert.equal(store.list({ state: 'queued' }).length, 0);
    assert.equal(migrateLegacyOperations({ legacyRoot: dataRoot, archiveRoot, store }).imported, 2);
    assert.equal(store.list().length, 2);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await readFile(join(archiveRoot, 'command-automation.sqlite')), before);
    if (process.platform !== 'win32') assert.equal((await lstat(join(archiveRoot, 'command-automation.sqlite'))).mode & 0o777, 0o400);
    assert.match(receipt.outputRetention.unavailable, /never replay/);
  } finally { store.close(); }
});

test('legacy global request-key collisions fail explicitly without overwriting either original journal', async t => {
  const { root, dataRoot } = await fixture(t), requestKey = 'shared-original-request-key';
  const firstPath = join(dataRoot, 'command-automation.sqlite'), secondPath = join(dataRoot, 'agent-cli.sqlite');
  legacy(firstPath, [{ id: 'a'.repeat(48), requestKey, state: 'completed', createdAt: 10 }]);
  legacy(secondPath, [{ id: 'b'.repeat(48), requestKey, state: 'failed', createdAt: 11 }]);
  const firstBytes = await readFile(firstPath), secondBytes = await readFile(secondPath), store = createOperationStore(dataRoot);
  try {
    assert.throws(() => migrateLegacyOperations({ legacyRoot: dataRoot, archiveRoot: join(root, 'archive'), store }), { code: 'OPERATION_KEY_CONFLICT' });
    assert.equal(store.find(requestKey).job.id, 'a'.repeat(48));
    assert.equal(store.get('b'.repeat(48)), null);
    assert.deepEqual(await readFile(firstPath), firstBytes); assert.deepEqual(await readFile(secondPath), secondBytes);
  } finally { store.close(); }
});

test('unsupported and unclean old schemas fail before import without changing the old database', async t => {
  const { root, dataRoot } = await fixture(t), path = join(dataRoot, 'agent-cli.sqlite');
  const db = new DatabaseSync(path); db.exec('CREATE TABLE wrong_schema(id TEXT)'); db.close();
  const before = await readFile(path);
  assert.throws(() => readLegacyOperationHistory(dataRoot), { code: 'UNSUPPORTED_LEGACY_SCHEMA' });
  assert.deepEqual(await readFile(path), before);
  await writeFile(path + '-journal', 'interrupted');
  assert.throws(() => migrateLegacyOperations({ legacyRoot: dataRoot, archiveRoot: join(root, 'archive'), store: { importLegacy() { assert.fail('must not import'); } } }), { code: 'LEGACY_NOT_QUIESCENT' });
});

test('recovery checks payloads and new durable stores, not only operations rows', async t => {
  const { dataRoot } = await fixture(t);
  await writeFile(join(dataRoot, 'operations.sqlite'), 'baseline');
  await mkdir(join(dataRoot, 'command-outputs'));
  const payload = join(dataRoot, 'command-outputs', 'a'.repeat(48) + '.out');
  await writeFile(payload, 'old-output');
  const before = await durableFingerprint(dataRoot);
  await writeFile(payload, 'new-output');
  assert.notEqual(await durableFingerprint(dataRoot), before);
  await mkdir(join(dataRoot, 'new-store'));
  await assert.rejects(durableFingerprint(dataRoot), { code: 'UNSUPPORTED_DURABLE_DATA' });
});

test('fingerprints cover capacity and known SQLite sidecars while unknown database names remain refused', async t => {
  const { dataRoot } = await fixture(t);
  const names = ['command-automation', 'agent-cli', 'maintenance', 'operations', 'capacity']
    .flatMap(name => ['', '-journal', '-wal', '-shm'].map(suffix => name + '.sqlite' + suffix));
  for (const name of names) await writeFile(join(dataRoot, name), 'baseline:' + name);
  for (const name of names) {
    const before = await durableFingerprint(dataRoot);
    await writeFile(join(dataRoot, name), 'changed:' + name);
    assert.notEqual(await durableFingerprint(dataRoot), before, name + ' must participate in the recovery barrier');
  }
  for (const name of ['unknown.sqlite', 'unknown.sqlite-wal', 'capacity.sqlite.backup', 'capacity.sqlite-journal-extra']) {
    const path = join(dataRoot, name); await writeFile(path, 'unsupported');
    await assert.rejects(durableFingerprint(dataRoot), { code: 'UNSUPPORTED_DURABLE_DATA' });
    await rm(path);
  }
});

test('recover refuses a downmigration after new writes and leaves candidate selected and data intact', { skip: process.platform === 'win32' }, async t => {
  const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
  const release = join(appRoot, 'releases', generation), previousRelease = join(appRoot, 'releases', 'previous');
  // Keep the deploy fixture private even when the test host's umask permits group writes.
  await mkdir(appRoot, { mode: 0o700 });
  await mkdir(release, { recursive: true }); await mkdir(previousRelease);
  await mkdir(join(appRoot, 'deployments'), { mode: 0o700 });
  const activePath = join(appRoot, 'approval-bridge'); await symlink(release, activePath);
  const plan = { generation, sourceDir: join(root, 'unavailable-source'), appRoot, activePath, dataRoot,
    healthUrl: 'http://127.0.0.1:39999/health', service: { stop: [process.execPath, '-e', 'process.exit(0)'], start: [process.execPath, '-e', 'process.exit(0)'], status: [process.execPath, '-e', 'process.exit(3)'] } };
  await writeFile(join(dataRoot, 'operations.sqlite'), 'imported-baseline');
  const baseline = await durableFingerprint(dataRoot);
  await writeFile(join(appRoot, 'deployments', generation + '.json'), JSON.stringify({ planHash: hash(JSON.stringify(plan)), generation, phase: 'activated', previousRelease, baseline }));
  await writeFile(join(dataRoot, 'operations.sqlite'), 'new-admission');
  await assert.rejects(runDeployment('recover', plan), { code: 'DOWNMIGRATION_FORBIDDEN_AFTER_WRITES' });
  assert.equal(await readlink(activePath), release);
  assert.equal(await readFile(join(dataRoot, 'operations.sqlite'), 'utf8'), 'new-admission');
});

test('capacity database and sidecar writes each prevent automatic recovery without changing the active release or data', { skip: process.platform === 'win32' }, async t => {
  for (const changedName of ['capacity.sqlite', 'capacity.sqlite-journal', 'capacity.sqlite-wal', 'capacity.sqlite-shm']) await t.test(changedName, async t => {
    const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
    const release = join(appRoot, 'releases', generation), previousRelease = join(appRoot, 'releases', 'previous');
    await mkdir(appRoot, { mode: 0o700 }); await mkdir(release, { recursive: true }); await mkdir(previousRelease);
    await mkdir(join(appRoot, 'deployments'), { mode: 0o700 });
    const activePath = join(appRoot, 'approval-bridge'); await symlink(release, activePath);
    const plan = { generation, sourceDir: join(root, 'unavailable-source'), appRoot, activePath, dataRoot,
      healthUrl: 'http://127.0.0.1:39999/health', service: { stop: [process.execPath, '-e', 'process.exit(0)'], start: [process.execPath, '-e', 'process.exit(0)'], status: [process.execPath, '-e', 'process.exit(3)'] } };
    const operationPath = join(dataRoot, 'operations.sqlite'), changedPath = join(dataRoot, changedName);
    await writeFile(operationPath, 'unchanged-operations');
    for (const name of ['capacity.sqlite', 'capacity.sqlite-journal', 'capacity.sqlite-wal', 'capacity.sqlite-shm']) await writeFile(join(dataRoot, name), 'capacity-baseline:' + name);
    const baseline = await durableFingerprint(dataRoot);
    await writeFile(join(appRoot, 'deployments', generation + '.json'), JSON.stringify({ planHash: hash(JSON.stringify(plan)), generation, phase: 'activated', previousRelease, baseline }));
    await writeFile(changedPath, 'new-capacity-write:' + changedName);
    await assert.rejects(runDeployment('recover', plan), { code: 'DOWNMIGRATION_FORBIDDEN_AFTER_WRITES' });
    assert.equal(await readlink(activePath), release);
    assert.equal(await readFile(operationPath, 'utf8'), 'unchanged-operations');
    assert.equal(await readFile(changedPath, 'utf8'), 'new-capacity-write:' + changedName);
  });
});
