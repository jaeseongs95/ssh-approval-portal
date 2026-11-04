import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, source), 'utf8').replaceAll('\r\n', '\n');
const install = read('scripts/install.sh');
const docker = read('docker/Dockerfile');
const packages = 'libx11-6 libxext6 libxinerama1 libxcursor1 libxi6 libxrender1 libxrandr2 libxfixes3 libxkbfile1 libssl3t64 libicu74'.split(' ');

test('fresh and reused native release prepare the pinned runtime after the mode sweep', () => {
  assert.ok(install.includes('prepare_private_gui() {'));
  const sweep = install.indexOf('find "$stage" -type f -exec chmod 0640');
  const prepare = install.indexOf('prepare_private_gui "$stage"');
  const publish = install.indexOf('mv -- "$stage" "$release"');
  assert.ok(sweep >= 0 && sweep < prepare && prepare < publish);
  assert.match(install, /else\n  prepare_private_gui "\$release"\nfi/);
});

test('Docker verifies and prepares the bundle in build stage and supplies its runtime ABI', () => {
  const [build, runtime] = docker.split('\nFROM ubuntu:24.04\n');
  assert.match(build, /install -y[^\n]*python3/);
  assert.ok(build.indexOf('node scripts/verify.mjs .') < build.indexOf('python3 scripts/prepare-freerdp-input.py'));
  assert.ok(build.indexOf('python3 scripts/prepare-freerdp-input.py') < build.indexOf('node scripts/check-package-imports.mjs'));
  for (const name of packages) assert.ok(runtime.includes(name), name);
  assert.match(runtime, /dpkg --print-architecture\)" = amd64/);
  assert.ok(runtime.includes('COPY --from=build /app /opt/portal'));
});

function fixture({ version = '24.04', architecture = 'x64', missing = false, aptExit = 0, repeat = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-install-paths-'));
  try {
    for (const dir of ['scripts', 'vendor', 'commands']) mkdirSync(join(root, dir), { mode: 0o755 });
    copyFileSync(new URL('scripts/prepare-freerdp-input.py', source), join(root, 'scripts/prepare-freerdp-input.py'));
    copyFileSync(new URL('vendor/freerdp-input-v1-linux-x64.tgz', source), join(root, 'vendor/freerdp-input-v1-linux-x64.tgz'));
    const archive = readFileSync(join(root, 'vendor/freerdp-input-v1-linux-x64.tgz'));
    writeFileSync(join(root, 'release-manifest.json'), JSON.stringify({ files: [{ path: 'vendor/freerdp-input-v1-linux-x64.tgz', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }] }));
    for (const [name, body] of [
      ['ldd', `#!/bin/sh\nprintf '%s\\n' '${missing ? 'libX11.so.6 => not found' : 'all dependencies resolved'}'\n`],
      ['apt-get', `#!/bin/sh\nprintf '%s\\n' "$*" >> "$APT_TRACE"\nexit ${aptExit}\n`],
    ]) writeFileSync(join(root, 'commands', name), body, { mode: 0o755 });
    const fn = install.match(/prepare_private_gui\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn, 'actual installer preparation function');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `${fn}\narchitecture=$2\nVERSION_ID=$3\nprepare_private_gui "$1"\n${repeat ? 'prepare_private_gui "$1"\n' : ''}`, 'fixture', root, architecture, version], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: join(root, 'commands') + ':' + process.env.PATH, APT_TRACE: join(root, 'apt.trace') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const executable = join(root, 'native/freerdp-input/runtime/bin/xfreerdp3');
    return { result, mode: statSync(executable).mode & 0o777, apt: (() => { try { return readFileSync(join(root, 'apt.trace'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } })() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('actual preparation preserves executable mode and avoids apt when dependencies resolve', { skip: process.platform !== 'linux' }, () => {
  const { result, mode, apt } = fixture();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode, 0o755);
  assert.equal(apt, '');
  assert.equal(JSON.parse(result.stdout).status, 'prepared');
});

test('optional GUI package failure does not stop bridge installation', { skip: process.platform !== 'linux' }, () => {
  const { result, apt } = fixture({ missing: true, aptExit: 42 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(apt.trim(), 'update');
  assert.match(result.stderr, /bridge installation continues/);
});

test('existing release preparation reuses the validated executable without changing its mode', { skip: process.platform !== 'linux' }, () => {
  const { result, mode } = fixture({ repeat: true });
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line).status), ['prepared', 'reused']);
  assert.equal(mode, 0o755);
});

test('Ubuntu22.04 retains bridge support without installing incompatible GUI libraries', { skip: process.platform !== 'linux' }, () => {
  const { result, apt } = fixture({ version: '22.04', missing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(apt, '');
});

test('Ubuntu24.04 missing ABI installs only the pinned runtime dependency set', { skip: process.platform !== 'linux' }, () => {
  const { result, apt } = fixture({ missing: true });
  assert.equal(result.status, 0, result.stderr);
  for (const name of packages) assert.ok(apt.includes(name), name);
  assert.ok(!apt.includes('freerdp3-x11'));
  assert.ok(!apt.includes('tigervnc'));
});
