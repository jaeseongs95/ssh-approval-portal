import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createOperationStore } from '../src/adapters/storage/operation-store.mjs';
import { createCommandState } from '../src/adapters/storage/command-state.mjs';
import { createAgentCliState } from '../src/adapters/storage/agent-cli-state.mjs';
import { AGENT_CLI_CONTRACT } from '../src/domain/agent-cli.mjs';
import { migrateLegacyOperations, readLegacyOperationHistory } from '../src/adapters/storage/operation-migration.mjs';
import { durableFingerprint, runDeployment, prepareDeploymentMigration } from '../scripts/deploy180.mjs';

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

test('redeployment preserves the first import after real 1.8 journal recovery and still detects conflicting original evidence', async t => {
  const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
  const release = fileURLToPath(new URL('../', import.meta.url)), control = join(appRoot, 'deployments');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const commandJobs = ['running', 'pending'].map((state, index) => ({ id: String(index + 1).repeat(48), kind: 'command', state, createdAt: 10 + index, operation: { kind: 'command', command: 'printf preserved' } }));
  const cliJobs = ['queued', 'pending'].map((state, index) => ({ id: String(index + 3).repeat(48), kind: 'command', state, createdAt: 12 + index, operation: { agentCliContract: AGENT_CLI_CONTRACT } }));
  let commands = createCommandState(dataRoot), cli = createAgentCliState(dataRoot);
  try {
    for (const job of commandJobs) commands.insert(job, 'command:' + job.id, hash(JSON.stringify(job)));
    for (const job of cliJobs) cli.insert(job, 'agent-cli:' + job.id, hash(JSON.stringify(job)));
  } finally { commands.close(); cli.close(); }
  const plan = { appRoot, dataRoot, generation }, first = await prepareDeploymentMigration(plan, release);
  assert.equal(first.imported, 4); assert.equal(first.unknown, 4);
  await writeFile(join(control, generation + '.json'), JSON.stringify({ generation, phase: 'activated', migration: first }));
  commands = createCommandState(dataRoot); cli = createAgentCliState(dataRoot);
  try {
    assert.deepEqual(commands.list().map(job => job.state), ['unknown', 'expired']);
    assert.deepEqual(cli.list().map(job => job.state), ['unknown', 'expired']);
  } finally { commands.close(); cli.close(); }
  const paths = ['command-automation.sqlite', 'agent-cli.sqlite', 'operations.sqlite'];
  const before = await Promise.all(paths.map(name => readFile(join(dataRoot, name))));
  const second = await prepareDeploymentMigration({ ...plan, generation: 'b'.repeat(64) }, release, { previousGeneration: generation });
  assert.equal(second.reused, true); assert.equal(second.originalGeneration, generation);
  for (let i = 0; i < paths.length; i++) assert.deepEqual(await readFile(join(dataRoot, paths[i])), before[i]);
  await assert.rejects(lstat(join(appRoot, 'legacy-archives', 'b'.repeat(64))), { code: 'ENOENT' });
  // A receipt written by the previous deployer is authoritative even without the new global marker.
  await rm(join(control, 'legacy-migration.json'));
  const adopted = await prepareDeploymentMigration({ ...plan, generation: 'c'.repeat(64) }, release, { previousGeneration: generation });
  assert.equal(adopted.reused, true); assert.equal(adopted.originalGeneration, generation);
  const store = createOperationStore(dataRoot);
  let corrupted;
  try {
    assert.equal(store.list().length, 4); assert.equal(store.list({ state: 'queued' }).length, 0);
    const original = store.get(commandJobs[0].id);
    assert.deepEqual(original.legacy.original, commandJobs[0]);
    const legacy = { ...original.legacy, original: { ...original.legacy.original, state: 'failed' } };
    assert.throws(() => store.update(original.id, { legacy }), { code: 'OPERATION_CONTRACT_IMMUTABLE' });
    corrupted = { ...original, legacy };
  } finally { store.close(); }
  // Corrupt only this synthetic target after releasing its exclusive connection.
  // Public updates now protect imported evidence; the reuse check must still
  // detect storage corruption rather than silently accepting conflicting history.
  const corruptor = new DatabaseSync(join(dataRoot, 'operations.sqlite'));
  try { corruptor.prepare('UPDATE operations SET body=? WHERE id=?').run(JSON.stringify(corrupted), corrupted.id); }
  finally { corruptor.close(); }
  const conflicted = await readFile(join(dataRoot, 'operations.sqlite'));
  await assert.rejects(prepareDeploymentMigration({ ...plan, generation: 'd'.repeat(64) }, release), { code: 'OPERATION_KEY_CONFLICT' });
  assert.deepEqual(await readFile(join(dataRoot, 'operations.sqlite')), conflicted);
  for (let i = 0; i < 2; i++) assert.deepEqual(await readFile(join(dataRoot, paths[i])), before[i]);
});

test('an existing 1.8 deployment requires authoritative completed migration evidence and never guesses from a partial state', async t => {
  const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), previousGeneration = 'a'.repeat(64);
  const control = join(appRoot, 'deployments'), previousRelease = join(root, 'previous');
  await mkdir(control, { recursive: true, mode: 0o700 }); await mkdir(previousRelease);
  await writeFile(join(previousRelease, 'release-manifest.json'), JSON.stringify({ version: '1.8.0' }));
  const path = join(dataRoot, 'command-automation.sqlite'); legacy(path, [{ id: 'a'.repeat(48), state: 'running', createdAt: 10 }]);
  const before = await readFile(path), plan = { appRoot, dataRoot, generation: 'b'.repeat(64) }, release = fileURLToPath(new URL('../', import.meta.url));
  for (const prior of [null, { generation: previousGeneration, phase: 'migrating', migration: { type: 'portal.operation-migration.v1', sources: [], imported: 0, unknown: 0 } }]) {
    if (prior) await writeFile(join(control, previousGeneration + '.json'), JSON.stringify(prior));
    await assert.rejects(prepareDeploymentMigration(plan, release, { previousGeneration, previousRelease }), { code: 'LEGACY_MIGRATION_RECEIPT_REQUIRED' });
    assert.deepEqual(await readFile(path), before);
    await assert.rejects(lstat(join(dataRoot, 'operations.sqlite')), { code: 'ENOENT' });
  }
});

test('migration reuse rejects an archive symlink before opening its target', { skip: process.platform === 'win32' }, async t => {
  const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
  await mkdir(join(appRoot, 'deployments'), { recursive: true, mode: 0o700 });
  legacy(join(dataRoot, 'command-automation.sqlite'), [{ id: 'a'.repeat(48), state: 'completed', createdAt: 10 }]);
  const plan = { appRoot, dataRoot, generation }, release = fileURLToPath(new URL('../', import.meta.url));
  await prepareDeploymentMigration(plan, release);
  const archived = join(appRoot, 'legacy-archives', generation, 'command-automation.sqlite');
  await rm(archived); await symlink(join(root, 'absent-target.sqlite'), archived);
  await assert.rejects(prepareDeploymentMigration({ ...plan, generation: 'b'.repeat(64) }, release), { code: 'UNSAFE_LEGACY_FILE' });
});

test('a restored 1.7 writer with additional history cannot silently reuse an earlier migration marker', async t => {
  const { root, dataRoot } = await fixture(t), appRoot = join(root, 'app'), generation = 'a'.repeat(64);
  const control = join(appRoot, 'deployments'), previousRelease = join(root, 'previous');
  await mkdir(control, { recursive: true, mode: 0o700 }); await mkdir(previousRelease);
  await writeFile(join(previousRelease, 'release-manifest.json'), JSON.stringify({ version: '1.7.6' }));
  const source = join(dataRoot, 'command-automation.sqlite');
  legacy(source, [{ id: 'a'.repeat(48), state: 'completed', createdAt: 10 }]);
  const plan = { appRoot, dataRoot, generation }, release = fileURLToPath(new URL('../', import.meta.url));
  await prepareDeploymentMigration(plan, release);
  const next = { ...plan, generation: 'b'.repeat(64) };
  assert.equal((await prepareDeploymentMigration(next, release, { previousRelease })).reused, true, 'Unchanged legacy evidence remains reusable');
  const later = { id: 'b'.repeat(48), state: 'pending', createdAt: 20 }, db = new DatabaseSync(source);
  try { db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(later.id, JSON.stringify(later), hash(JSON.stringify(later)), 'original:' + later.id); } finally { db.close(); }
  const protectedPaths = [source, join(dataRoot, 'operations.sqlite'), join(control, 'legacy-migration.json'), join(appRoot, 'legacy-archives', generation, 'command-automation.sqlite')];
  const before = await Promise.all(protectedPaths.map(path => readFile(path)));
  await assert.rejects(prepareDeploymentMigration(next, release, { previousRelease }), { code: 'LEGACY_MIGRATION_SOURCE_CHANGED' });
  for (let i = 0; i < protectedPaths.length; i++) assert.deepEqual(await readFile(protectedPaths[i]), before[i]);
  await assert.rejects(lstat(join(appRoot, 'legacy-archives', next.generation)), { code: 'ENOENT' });
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
