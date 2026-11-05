import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, chown, lstat, readFile, writeFile, rm, symlink, readlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const rootLinux = process.platform === 'linux' && process.getuid() === 0;
const deployUrl = new URL('../scripts/deploy180.mjs', import.meta.url).href;
const digest = value => createHash('sha256').update(value).digest('hex');
function serviceIdentity(t) {
  const query = flag => spawnSync('/usr/bin/id', [flag, 'mcpbridge'], { encoding: 'utf8', timeout: 5000 });
  const uid = query('-u'), gid = query('-g');
  if (uid.status !== 0 || gid.status !== 0 || !/^\d+\s*$/.test(uid.stdout) || !/^\d+\s*$/.test(gid.stdout)) {
    t.skip('requires the TEST mcpbridge service account'); return null;
  }
  assert.notEqual(Number(uid.stdout), 0);
  return { uid: Number(uid.stdout), gid: Number(gid.stdout) };
}
async function fixture(t, version = '2.0.0') {
  const identity = serviceIdentity(t); if (!identity) return null;
  const root = await mkdtemp(join(tmpdir(), 'portal-release-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const sourceDir = join(root, 'source'), appRoot = join(root, 'app'), dataRoot = join(root, 'data');
  await mkdir(sourceDir); await mkdir(join(sourceDir, 'src')); await mkdir(dataRoot, { mode: 0o700 });
  await chmod(dataRoot, 0o700); await chown(dataRoot, identity.uid, identity.gid);
  const files = {
    'package.json': JSON.stringify({ name: 'deployment-permissions-fixture', version, type: 'module' }),
    'package-lock.json': '{}', 'bridge.mjs': 'export {};\n',
    'app.mjs': "import { value } from './node_modules/fixture/lib/entry.mjs'; export function createApplication() { return value; }\n",
    'scripts/check-package-imports.mjs': await readFile(new URL('../scripts/check-package-imports.mjs', import.meta.url), 'utf8'),
    'scripts/windows-file-helper.ps1': '# fixture\n', 'scripts/windows-file-native.cs': '// fixture\n',
    'scripts/install-windows-helper.ps1': '# fixture\n', 'config/settings-contract.json': '{}',
    'ui/dist/card.html': '<html></html>', 'web/dist/app.js': 'export {};',
    'deploy/oidc/Caddyfile': '# fixture\n', 'deploy/oidc/oauth2-proxy.cfg': '# fixture\n',
    'src/private-fixture.json': '{}',
  };
  const modes = new Map();
  for (const [path, body] of Object.entries(files)) {
    const full = join(sourceDir, path), mode = path === 'bridge.mjs' ? 0o755 : path === 'src/private-fixture.json' ? 0o600 : 0o644;
    await mkdir(dirname(full), { recursive: true }); await writeFile(full, body); await chmod(full, mode); modes.set(path, mode);
  }
  const manifest = JSON.stringify({ version, files: Object.entries(files).map(([path, body]) => ({ path, size: Buffer.byteLength(body), sha256: digest(body) })) });
  await writeFile(join(sourceDir, 'release-manifest.json'), manifest); await chmod(join(sourceDir, 'release-manifest.json'), 0o644);
  modes.set('release-manifest.json', 0o644);
  const outside = join(root, 'private-outside'); await mkdir(outside); await chmod(outside, 0o700);
  await writeFile(join(outside, 'secret-fixture'), 'preserve\n'); await chmod(join(outside, 'secret-fixture'), 0o400);
  // Replace only the npm subprocess boundary: emulate dependency extraction
  // under the deployer's real umask, including a symlink outside the code tree.
  const npmExecutable = join(root, 'fixture-npm');
  await writeFile(npmExecutable, `#!${process.execPath}\n` +
    `const fs=require('node:fs');fs.mkdirSync('node_modules/fixture/lib',{recursive:true});` +
    `fs.writeFileSync('node_modules/fixture/lib/entry.mjs','export const value = 42;\\n');` +
    `fs.symlinkSync(${JSON.stringify(outside)},'node_modules/outside-link');\n`);
  await chmod(npmExecutable, 0o755);
  const generation = digest(manifest), plan = { generation, sourceDir, appRoot, dataRoot, activePath: join(appRoot, 'current'), npmExecutable,
    healthUrl: 'http://127.0.0.1:39999/health', service: { stop: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'stop-called'))},'stop')`],
      start: [process.execPath, '-e', 'process.exit(0)'], status: [process.execPath, '-e', 'process.exit(3)'] } };
  const planPath = join(root, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
  return { root, identity, outside, modes, plan, planPath, release: join(appRoot, 'releases', generation) };
}
function stagePrivate(f, stage = 'stage') {
  // umask belongs exclusively to this subprocess; the test runner never changes it.
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {readFile} from 'node:fs/promises';const {runDeployment}=await import(process.argv[2]);process.umask(0o077);` +
    `try {console.log(JSON.stringify(await runDeployment(process.argv[3],JSON.parse(await readFile(process.argv[1],'utf8')))))} ` +
    `catch(error){console.log(JSON.stringify({status:'failed',code:error.code}));process.exitCode=1}`, f.planPath, deployUrl, stage],
  { encoding: 'utf8', timeout: 30000 });
}

test('inspect accepts a 2.0 patch candidate and refuses historical or unsupported candidate versions before writing deployment state', { skip: !rootLinux }, async t => {
  for (const version of ['2.0.3', '1.8.0', '2.1.0', '2.0.0-beta.1']) await t.test(version, async t => {
    const f = await fixture(t, version); if (!f) return;
    const result = stagePrivate(f, 'inspect'), receipt = JSON.parse(result.stdout);
    assert.equal(result.status, version === '2.0.3' ? 0 : 1, result.stdout + result.stderr);
    if (version === '2.0.3') assert.equal(receipt.version, version);
    else assert.equal(receipt.code, 'UNSUPPORTED_DEPLOY_VERSION');
    await assert.rejects(lstat(f.plan.appRoot), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.root, 'stop-called')), { code: 'ENOENT' });
  });
});

for (const existingParent of [false, true]) test(`umask077 staging permits real service imports with ${existingParent ? 'existing' : 'new'} public deployment parents`, { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  const releases = join(f.plan.appRoot, 'releases');
  if (existingParent) {
    await mkdir(f.plan.appRoot); await chmod(f.plan.appRoot, 0o751);
    await mkdir(releases); await chmod(releases, 0o711);
  }
  const runnerUmask = process.umask(), result = stagePrivate(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, 'staged');
  assert.equal(process.umask(), runnerUmask, 'the isolated child must not mutate the test runner umask');
  assert.equal((await lstat(f.plan.appRoot)).mode & 0o777, existingParent ? 0o751 : 0o755);
  assert.equal((await lstat(releases)).mode & 0o777, existingParent ? 0o711 : 0o755);
  async function directories(path) {
    assert.equal((await lstat(path)).mode & 0o777, 0o755, path);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await directories(join(path, entry.name));
  }
  await directories(f.release);
  for (const [path, mode] of f.modes) assert.equal((await lstat(join(f.release, path))).mode & 0o777, mode, 'packaged file mode: ' + path);
  assert.equal((await lstat(join(f.release, 'node_modules/fixture/lib/entry.mjs'))).mode & 0o777, 0o644);
  assert.equal((await lstat(join(f.plan.appRoot, 'deployments'))).mode & 0o777, 0o700);
  assert.equal((await lstat(f.outside)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.outside, 'secret-fixture'))).mode & 0o777, 0o400);
  assert.equal(await readFile(join(f.outside, 'secret-fixture'), 'utf8'), 'preserve\n');
  const check = spawnSync(process.execPath, [join(f.release, 'scripts/check-package-imports.mjs')], { ...f.identity, cwd: f.release, encoding: 'utf8', timeout: 10000 });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /Packaged application imports resolved/);
});

test('activation detects service-uid import access failure before stopping the previous service', { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  const staged = stagePrivate(f); assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  await chmod(f.release, 0o700);
  const result = stagePrivate(f, 'activate');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'DEPLOY_SERVICE_IMPORT_CHECK_FAILED');
  await assert.rejects(lstat(join(f.root, 'stop-called')), { code: 'ENOENT' });
  const state = JSON.parse(await readFile(join(f.plan.appRoot, 'deployments', f.plan.generation + '.json'), 'utf8'));
  assert.equal(state.phase, 'staged');
  assert.equal((await lstat(f.release)).mode & 0o777, 0o700, 'existing permissions remain operator controlled');
});

test('pre-start recovery can select a preserved 1.8 release without accepting it as a new candidate', { skip: !rootLinux }, async t => {
  const f = await fixture(t), historical = await fixture(t, '1.8.0'); if (!f || !historical) return;
  const staged = stagePrivate(f); assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const started = join(f.root, 'start-called'), stopped = join(f.root, 'stop-called');
  f.plan.service.start = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(started)},'start')`];
  f.plan.service.status = [process.execPath, '-e', `process.exit(require('node:fs').existsSync(${JSON.stringify(stopped)})&&!require('node:fs').existsSync(${JSON.stringify(started)})?3:0)`];
  await writeFile(f.planPath, JSON.stringify(f.plan));
  const previousRelease = historical.plan.sourceDir;
  const previousGeneration = digest(await readFile(join(previousRelease, 'release-manifest.json')));
  await writeFile(join(f.plan.appRoot, 'deployments', f.plan.generation + '.json'), JSON.stringify({
    generation: f.plan.generation, planHash: digest(JSON.stringify(f.plan)), phase: 'switching', previousRelease, previousGeneration,
  }));
  await symlink(f.release, f.plan.activePath);
  const recovered = stagePrivate(f, 'recover');
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).phase, 'recovered');
  assert.equal(await readlink(f.plan.activePath), previousRelease);
  assert.equal(await readFile(started, 'utf8'), 'start');
});

for (const unsafe of ['writable', 'foreign-owner', 'symlink']) test(`staging refuses an ${unsafe} releases parent without changing it`, { skip: !rootLinux }, async t => {
  const f = await fixture(t); if (!f) return;
  await mkdir(f.plan.appRoot); await chmod(f.plan.appRoot, 0o755);
  const releases = join(f.plan.appRoot, 'releases'); let observed = releases;
  if (unsafe === 'symlink') { observed = f.outside; await symlink(observed, releases); }
  else {
    await mkdir(releases); await chmod(releases, unsafe === 'writable' ? 0o777 : 0o700);
    if (unsafe === 'foreign-owner') await chown(releases, f.identity.uid, f.identity.gid);
  }
  const before = await lstat(observed), result = stagePrivate(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 'UNSAFE_DEPLOY_RELEASES');
  const after = await lstat(observed);
  for (const key of ['ino', 'dev', 'uid', 'gid', 'mode']) assert.equal(after[key], before[key]);
  await assert.rejects(lstat(f.release), { code: 'ENOENT' });
});
