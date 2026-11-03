#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, readFile, mkdir, open, rename, symlink, readlink, unlink, copyFile, readdir, chown, chmod, statfs } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyRelease } from './verify.mjs';

const fail = code => { throw Object.assign(Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(8).toString('hex');
async function optionalStat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); }
}
async function syncTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await syncTree(child);
    else if (entry.isFile()) { const fd = await open(child, 'r'); try { await fd.sync(); } finally { await fd.close(); } }
  }
  await syncDirectory(path);
}
async function atomicJson(path, value) {
  const temporary = path + '.' + token();
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
function command(argv, { cwd, expected = 0, timeout = 60000, uid, gid, input, failureCode = 'DEPLOY_COMMAND_FAILED', typedReceipt = false } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(part => typeof part !== 'string' || part.includes('\0'))) fail('INVALID_DEPLOY_COMMAND');
  const result = spawnSync(argv[0], argv.slice(1), { cwd, timeout, uid, gid, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status !== expected) {
    if (typedReceipt) {
      let receipt; try { receipt = JSON.parse(result.stdout); } catch { /* An interrupted child has no authoritative receipt. */ }
      if (receipt?.type === 'portal.deployment-receipt.v1' && receipt.status === 'failed' && /^[A-Z][A-Z0-9_]+$/.test(receipt.code)) fail(receipt.code);
    }
    fail(result.error?.code === 'ETIMEDOUT' ? 'DEPLOY_COMMAND_TIMEOUT' : failureCode);
  }
  return result.stdout;
}
function normalizePlan(input) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.generation)) fail('INVALID_DEPLOY_GENERATION');
  for (const key of ['sourceDir', 'appRoot', 'activePath', 'dataRoot']) if (typeof input[key] !== 'string' || !input[key]) fail('INVALID_DEPLOY_PATH');
  const plan = { ...input, ...Object.fromEntries(['sourceDir', 'appRoot', 'activePath', 'dataRoot'].map(key => [key, resolve(input[key])])) };
  if (dirname(plan.activePath) !== plan.appRoot || plan.dataRoot === plan.appRoot || !input.service) fail('INVALID_DEPLOY_LAYOUT');
  for (const action of ['stop', 'start', 'status']) if (!Array.isArray(input.service[action]) || !input.service[action].length) fail('INVALID_DEPLOY_SERVICE');
  const url = new URL(input.healthUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) fail('INVALID_DEPLOY_HEALTH_URL');
  return plan;
}
async function candidate(root, generation) {
  const st = await lstat(root); if (!st.isDirectory() || st.isSymbolicLink()) fail('UNSAFE_DEPLOY_SOURCE');
  const manifestStat = await lstat(join(root, 'release-manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.size > 8 * 1024 * 1024) fail('UNSAFE_DEPLOY_MANIFEST');
  const bytes = await readFile(join(root, 'release-manifest.json'));
  if (hash(bytes) !== generation) fail('DEPLOY_GENERATION_MISMATCH');
  const manifest = JSON.parse(bytes);
  if (!/^1\.8\.\d+$/.test(manifest.version)) fail('UNSUPPORTED_DEPLOY_VERSION');
  await verifyRelease(root);
  return manifest;
}
async function activeTarget(plan) {
  const st = await optionalStat(plan.activePath);
  if (!st) return null;
  if (!st.isSymbolicLink()) fail('ACTIVE_RELEASE_MUST_BE_SYMLINK');
  const target = resolve(dirname(plan.activePath), await readlink(plan.activePath));
  if (!relative(join(plan.appRoot, 'releases'), target) || relative(join(plan.appRoot, 'releases'), target).startsWith('..')) fail('ACTIVE_RELEASE_OUTSIDE_RELEASES');
  return target;
}
async function swapActive(plan, target) {
  const next = join(plan.appRoot, '.deploy180-next-' + token());
  await symlink(target, next, 'dir'); await rename(next, plan.activePath); await syncDirectory(plan.appRoot);
}
async function fileDigest(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })) digest.update(chunk);
  return digest.digest('hex');
}
/** Hash every supported durable store and artifact; an unfamiliar entry blocks recovery. */
export async function durableFingerprint(dataRoot) {
  const root = await lstat(dataRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) fail('UNSAFE_DEPLOY_DATA');
  const rows = [];
  async function scan(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), key = prefix + name, st = await lstat(path, { bigint: true });
      if (st.isSymbolicLink()) fail('UNSAFE_DEPLOY_DATA');
      if (!prefix && ['command-outputs', 'orphans'].includes(name) && st.isDirectory()) { await scan(path, name + '/'); continue; }
      const accepted = prefix === 'orphans/' ? /^[a-f0-9]{48}\.(part|json)$/.test(name)
        : prefix ? /^(manifest\.sqlite(?:-(?:journal|wal|shm))?|[a-f0-9]{48}\.(out|part|stream))$/.test(name)
        : /^(command-automation|agent-cli|maintenance|operations|capacity)\.sqlite(?:-(?:journal|wal|shm))?$/.test(name) || /^[a-f0-9]{48}\.(part|json)$/.test(name);
      if (!accepted || !st.isFile() || st.nlink !== 1n) fail('UNSUPPORTED_DURABLE_DATA');
      rows.push({ path: key, bytes: String(st.size), modified: String(st.mtimeNs), sha256: await fileDigest(path) });
    }
  }
  await scan(dataRoot);
  return hash(JSON.stringify(rows));
}

async function migrationControl(path) {
  const st = await optionalStat(path);
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 2 * 1024 * 1024) fail('UNSAFE_MIGRATION_RECEIPT');
  return JSON.parse(await readFile(path, 'utf8'));
}
function validMigration(receipt) {
  return receipt?.type === 'portal.operation-migration.v1' && Array.isArray(receipt.sources)
    && new Set(receipt.sources.map(source => source?.source)).size === receipt.sources.length
    && receipt.sources.every(source => source && ['command-automation.sqlite', 'agent-cli.sqlite'].includes(source.source)
      && /^[a-f0-9]{64}$/.test(source.sha256) && Number.isSafeInteger(source.imported) && source.imported >= 0
      && Number.isSafeInteger(source.unknown) && source.unknown >= 0 && source.unknown <= source.imported)
    && receipt.imported === receipt.sources.reduce((sum, source) => sum + source.imported, 0)
    && receipt.unknown === receipt.sources.reduce((sum, source) => sum + source.unknown, 0);
}

/** Completed migration archives are immutable evidence; live 1.8 journals are no longer import sources. */
export async function prepareDeploymentMigration(plan, release, { previousGeneration, previousRelease } = {}) {
  const control = join(plan.appRoot, 'deployments'), markerPath = join(control, 'legacy-migration.json');
  const owner = await lstat(plan.dataRoot);
  if (!owner.isDirectory() || owner.isSymbolicLink()) fail('UNSAFE_DEPLOY_DATA');
  const previousVersion = previousRelease ? JSON.parse(await readFile(join(previousRelease, 'release-manifest.json'), 'utf8')).version : null;
  let completed = await migrationControl(markerPath);
  if (!completed && previousGeneration) {
    const prior = await migrationControl(join(control, previousGeneration + '.json'));
    if (prior?.generation === previousGeneration && ['switching', 'start-attempted', 'activated', 'verified', 'recovered'].includes(prior.phase) && validMigration(prior.migration)) {
      completed = { type: 'portal.deployment-migration.v1', generation: prior.migration.reused === true ? prior.migration.originalGeneration : previousGeneration, dataRoot: plan.dataRoot, migration: prior.migration };
    }
  }
  const childOptions = { uid: process.platform === 'win32' ? undefined : owner.uid, gid: process.platform === 'win32' ? undefined : owner.gid, typedReceipt: true };
  if (completed) {
    if (completed.type !== 'portal.deployment-migration.v1' || completed.dataRoot !== plan.dataRoot || !/^[a-f0-9]{64}$/.test(completed.generation) || !validMigration(completed.migration)) fail('INVALID_MIGRATION_RECEIPT');
    if (typeof previousVersion === 'string' && /^(?:0\.\d+|1\.[0-7])\./.test(previousVersion)) {
      // A restored legacy writer can add history outside the 1.8 authoritative journal.
      for (const name of ['command-automation.sqlite', 'agent-cli.sqlite']) {
        const original = completed.migration.sources.find(source => source.source === name), path = join(plan.dataRoot, name), st = await optionalStat(path);
        if (Boolean(st) !== Boolean(original)) fail('LEGACY_MIGRATION_SOURCE_CHANGED');
        if (!st) continue;
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('UNSAFE_LEGACY_FILE');
        for (const suffix of ['-wal', '-journal']) if (await optionalStat(path + suffix)) fail('LEGACY_NOT_QUIESCENT');
        if (await fileDigest(path) !== original.sha256) fail('LEGACY_MIGRATION_SOURCE_CHANGED');
      }
    }
    const archiveRoot = join(plan.appRoot, 'legacy-archives', completed.generation);
    for (const path of [dirname(archiveRoot), archiveRoot]) { const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) fail('UNSAFE_LEGACY_ARCHIVE'); }
    for (const source of completed.migration.sources) {
      const path = join(archiveRoot, source.source), st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('UNSAFE_LEGACY_FILE');
      if (await fileDigest(path) !== source.sha256) fail('LEGACY_ARCHIVE_MISMATCH');
    }
    const { readLegacyOperationHistory } = await import('../src/adapters/storage/operation-migration.mjs');
    const inventory = readLegacyOperationHistory(archiveRoot);
    if (inventory.length !== completed.migration.sources.length || completed.migration.sources.some(source => !inventory.some(item => item.source === source.source && item.sha256 === source.sha256 && item.rows.length === source.imported))) fail('LEGACY_ARCHIVE_MISMATCH');
    const operations = await optionalStat(join(plan.dataRoot, 'operations.sqlite'));
    if (!operations || !operations.isFile() || operations.isSymbolicLink() || operations.nlink !== 1) fail('LEGACY_MIGRATION_STORE_MISSING');
    command([process.execPath, join(release, 'scripts/deploy180.mjs'), '--migration-check'], {
      ...childOptions, input: JSON.stringify({ legacyRoot: plan.dataRoot, inventory }),
    });
    await atomicJson(markerPath, completed);
    return { ...completed.migration, reused: true, originalGeneration: completed.generation };
  }
  if (/^1\.8\./.test(previousVersion)) fail('LEGACY_MIGRATION_RECEIPT_REQUIRED');
  const archiveRoot = join(plan.appRoot, 'legacy-archives', plan.generation);
  await mkdir(dirname(archiveRoot), { recursive: true, mode: 0o755 });
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  const archiveStat = await lstat(archiveRoot);
  if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) fail('UNSAFE_LEGACY_ARCHIVE');
  if (process.platform !== 'win32' && process.getuid() === 0) await chown(archiveRoot, owner.uid, owner.gid);
  const migration = JSON.parse(command([process.execPath, join(release, 'scripts/deploy180.mjs'), '--migration-child'], {
    ...childOptions, input: JSON.stringify({ legacyRoot: plan.dataRoot, archiveRoot }),
  }));
  if (!validMigration(migration)) fail('INVALID_MIGRATION_RECEIPT');
  if (process.platform !== 'win32' && process.getuid() === 0) {
    for (const entry of migration.sources) await chown(join(archiveRoot, entry.source), 0, 0);
    await chown(archiveRoot, 0, 0); await chmod(archiveRoot, 0o700);
  }
  await atomicJson(markerPath, { type: 'portal.deployment-migration.v1', generation: plan.generation, dataRoot: plan.dataRoot, migration });
  return migration;
}

/** The plan is operator input, never a remote request. Each invocation owns a short deployment lock. */
export async function runDeployment(stage, input, { fetchImpl = fetch } = {}) {
  if (!['inspect', 'stage', 'activate', 'verify', 'recover'].includes(stage)) fail('INVALID_DEPLOY_STAGE');
  const plan = normalizePlan(input);
  const release = join(plan.appRoot, 'releases', plan.generation), control = join(plan.appRoot, 'deployments');
  const manifest = stage === 'recover' ? null : await candidate(['inspect', 'stage'].includes(stage) ? plan.sourceDir : release, plan.generation);
  const receipt = { type: 'portal.deployment-receipt.v1', generation: plan.generation, stage, at: Date.now(), status: 'completed' };
  if (stage === 'inspect') {
    const existing = await activeTarget(plan), disk = await statfs(dirname(plan.appRoot));
    return { ...receipt, version: manifest.version, files: manifest.files.length, previousRelease: existing, freeBytes: Number(disk.bavail) * Number(disk.bsize),
      impact: 'Only packaged code, deployment receipts and the new operations journal are written. Existing policy/history DBs, auth configuration, keys and service units are preserved.' };
  }
  await mkdir(plan.appRoot, { recursive: true, mode: 0o755 });
  const appStat = await lstat(plan.appRoot);
  if (!appStat.isDirectory() || appStat.isSymbolicLink() || (process.platform !== 'win32' && (appStat.uid !== process.getuid() || (appStat.mode & 0o022)))) fail('UNSAFE_DEPLOY_ROOT');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const controlStat = await lstat(control);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink() || (process.platform !== 'win32' && (controlStat.uid !== process.getuid() || (controlStat.mode & 0o077)))) fail('UNSAFE_DEPLOY_CONTROL');
  const lockPath = join(plan.appRoot, '.deploy180.lock'), lock = await open(lockPath, 'wx', 0o600);
  try {
    const statePath = join(control, plan.generation + '.json'), planHash = hash(JSON.stringify(plan));
    const stateStat = await optionalStat(statePath);
    if (stateStat && (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.nlink !== 1 || stateStat.size > 2 * 1024 * 1024)) fail('UNSAFE_DEPLOY_STATE');
    let state = stateStat ? JSON.parse(await readFile(statePath, 'utf8')) : null;
    if (state && state.planHash !== planHash) fail('DEPLOY_PLAN_CHANGED');
    const save = async patch => { state = { ...state, ...patch, planHash, generation: plan.generation }; await atomicJson(statePath, state); };
    if (stage === 'stage') {
      if (state && state.phase !== 'staged') fail('DEPLOY_ALREADY_ACTIVATED');
      if (!await optionalStat(release)) {
        const needed = manifest.files.reduce((sum, entry) => sum + entry.size, 0) * 3 + 256 * 1024 * 1024;
        const disk = await statfs(plan.appRoot);
        if (Number(disk.bavail) * Number(disk.bsize) < needed) fail('DEPLOY_DISK_CAPACITY');
        await mkdir(join(plan.appRoot, 'releases'), { recursive: true, mode: 0o755 });
        const temporary = join(plan.appRoot, '.deploy180-stage-' + token()); await mkdir(temporary, { mode: 0o755 });
        for (const entry of [...manifest.files, { path: 'release-manifest.json' }]) {
          const target = join(temporary, entry.path); await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          await copyFile(join(plan.sourceDir, entry.path), target, constants.COPYFILE_EXCL);
        }
        await candidate(temporary, plan.generation);
        command([plan.npmExecutable ?? 'npm', 'ci', '--omit=dev', '--ignore-scripts'], { cwd: temporary, timeout: 600000, failureCode: 'DEPLOY_DEPENDENCY_INSTALL_FAILED' });
        command([process.execPath, join(temporary, 'scripts/check-package-imports.mjs')], { cwd: temporary, failureCode: 'DEPLOY_IMPORT_CHECK_FAILED' });
        await syncTree(temporary);
        await rename(temporary, release); await syncDirectory(dirname(release));
      }
      await candidate(release, plan.generation);
      const previousRelease = await activeTarget(plan);
      if (previousRelease) await verifyRelease(previousRelease);
      const previousGeneration = previousRelease ? hash(await readFile(join(previousRelease, 'release-manifest.json'))) : null;
      await save({ phase: 'staged', previousRelease, previousGeneration, version: manifest.version });
    } else {
      if (!state) fail('DEPLOY_STAGE_REQUIRED');
      if (stage === 'activate') {
        if (state.phase !== 'staged') fail('DEPLOY_ACTIVATION_ALREADY_ATTEMPTED');
        if (await activeTarget(plan) !== state.previousRelease) fail('DEPLOY_ACTIVE_CHANGED');
        await candidate(release, plan.generation);
        await save({ phase: 'stopping' });
        command(plan.service.stop, { failureCode: 'DEPLOY_SERVICE_STOP_FAILED' });
        command(plan.service.status, { expected: plan.service.stoppedExitCode ?? 3, failureCode: 'DEPLOY_SERVICE_STILL_ACTIVE' });
        await save({ phase: 'migrating' });
        const migration = await prepareDeploymentMigration(plan, release, state);
        const baseline = await durableFingerprint(plan.dataRoot);
        await save({ phase: 'switching', migration, baseline });
        await swapActive(plan, release);
        // Persist the barrier before start: a failed/lost start reply may still have admitted writes.
        await save({ phase: 'start-attempted' });
        command(plan.service.start, { failureCode: 'DEPLOY_SERVICE_START_FAILED' });
        await save({ phase: 'activated' });
      } else if (stage === 'verify') {
        if (!['activated', 'verified', 'start-attempted'].includes(state.phase)) fail('DEPLOY_ACTIVATION_REQUIRED');
        if (await activeTarget(plan) !== release) fail('DEPLOY_ACTIVE_CHANGED');
        await candidate(release, plan.generation); command(plan.service.status, { failureCode: 'DEPLOY_SERVICE_NOT_ACTIVE' });
        const response = await fetchImpl(plan.healthUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) fail('DEPLOY_HEALTH_FAILED');
        const health = await response.json();
        if (health.healthy !== true || health.version !== manifest.version || health.deploymentGeneration !== plan.generation) fail('DEPLOY_HEALTH_GENERATION_MISMATCH');
        await save({ phase: 'verified', verifiedAt: Date.now() });
      } else {
        if (['staged', 'recovered'].includes(state.phase)) fail('DEPLOY_RECOVERY_NOT_REQUIRED');
        // Stop before examining data; failure always retains the candidate and its journal.
        command(plan.service.stop, { failureCode: 'DEPLOY_SERVICE_STOP_FAILED' });
        command(plan.service.status, { expected: plan.service.stoppedExitCode ?? 3, failureCode: 'DEPLOY_SERVICE_STILL_ACTIVE' });
        const current = await activeTarget(plan);
        if (![release, state.previousRelease].includes(current)) fail('DEPLOY_ACTIVE_CHANGED');
        if (['start-attempted', 'activated', 'verified'].includes(state.phase)
          && (!state.baseline || await durableFingerprint(plan.dataRoot) !== state.baseline)) fail('DOWNMIGRATION_FORBIDDEN_AFTER_WRITES');
        if (!state.previousRelease) fail('DEPLOY_NO_PREVIOUS_RELEASE');
        if (hash(await readFile(join(state.previousRelease, 'release-manifest.json'))) !== state.previousGeneration) fail('DEPLOY_PREVIOUS_GENERATION_CHANGED');
        await verifyRelease(state.previousRelease);
        await save({ phase: 'recovering' });
        await swapActive(plan, state.previousRelease);
        command(plan.service.start, { failureCode: 'DEPLOY_SERVICE_START_FAILED' });
        command(plan.service.status, { failureCode: 'DEPLOY_SERVICE_NOT_ACTIVE' });
        await save({ phase: 'recovered', recoveredAt: Date.now() });
      }
    }
    const result = { ...receipt, phase: state.phase, release, ...(state.migration ? { migration: state.migration } : {}) };
    await atomicJson(join(control, plan.generation + '-' + stage + '-receipt.json'), result);
    return result;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (import.meta.main) {
  try {
    if (['--migration-child', '--migration-check'].includes(process.argv[2])) {
      const { createOperationStore } = await import('../src/adapters/storage/operation-store.mjs');
      const { migrateLegacyOperations } = await import('../src/adapters/storage/operation-migration.mjs');
      let text = ''; for await (const chunk of process.stdin) text += chunk;
      const options = JSON.parse(text), store = createOperationStore(options.legacyRoot);
      try {
        if (process.argv[2] === '--migration-check') {
          for (const { source, rows } of options.inventory) for (const { job, digest, requestKey } of rows) {
            if (!store.find(requestKey ?? `legacy:${source}:${job.id}`)) fail('LEGACY_MIGRATION_RECORD_MISSING');
            store.importLegacy(job, { source, digest, requestKey });
          }
          process.stdout.write(JSON.stringify({ type: 'portal.operation-migration-check.v1', status: 'completed' }));
        } else process.stdout.write(JSON.stringify(migrateLegacyOperations({ ...options, store })));
      } finally { store.close(); }
    } else {
      const [stage, flag, path, ...rest] = process.argv.slice(2);
      if (flag !== '--plan' || !path || rest.length) fail('USAGE_DEPLOY180_STAGE_PLAN');
      console.log(JSON.stringify(await runDeployment(stage, JSON.parse(await readFile(path, 'utf8')))));
    }
  } catch (error) {
    console.log(JSON.stringify({ type: 'portal.deployment-receipt.v1', stage: process.argv[2], status: 'failed', code: error.code ?? 'DEPLOY_FAILED', at: Date.now() }));
    process.exitCode = 1;
  }
}
