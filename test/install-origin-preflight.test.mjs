import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const install = readFileSync(join(root, 'scripts/install.sh'), 'utf8').replaceAll('\r\n', '\n');
const guard = install.match(/^preflight_admin_origin\(\) \{[\s\S]*?^\}/m)?.[0];
const linux = { skip: process.platform !== 'linux' };

function fixture(t, { env = false, origin = '', python = true, afterPrerequisites = false } = {}) {
  assert.ok(guard, 'Exercise the actual guard function extracted from install.sh');
  const temp = mkdtempSync(join(tmpdir(), 'origin-preflight-'));
  t.after(() => {
    assert.ok(temp.startsWith(join(tmpdir(), 'origin-preflight-')));
    rmSync(temp, { recursive: true, force: true });
  });
  const envFile = join(temp, 'fixture.env'), mutation = join(temp, 'mutation-sentinel');
  if (env) writeFileSync(envFile, 'existing-fixture-env-preserved\n');
  // Only the guard runs. Real apt/runtime/account/SSH/service commands are absent.
  const script = [
    'set -euo pipefail', 'source_dir=$1', 'env_file=$2', 'admin_origin=$3', 'origin_preflight_pending=0',
    python ? '' : 'command() { if [[ "$1" == -v && "${2:-}" == python3 ]]; then return 1; fi; builtin command "$@"; }',
    guard, 'preflight_admin_origin',
    afterPrerequisites ? 'unset -f command; if [[ "$origin_preflight_pending" == 1 ]]; then preflight_admin_origin; fi' : '',
    'printf \'%s\' "$origin_preflight_pending" > "$4"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script, 'fixture', root, envFile, origin, mutation], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return { result, envFile, mutation };
}

test('S07 actual guard executes before dependency, runtime, account, config and SSH mutations', () => {
  assert.ok(guard);
  const call = install.indexOf('\npreflight_admin_origin\n');
  assert.ok(call > install.indexOf(guard));
  for (const mutation of ['apt-get update', 'install -d -m 0755 "$app"', 'exec 9>', 'source "$source_dir/scripts/ensure-node-runtime.sh"', 'useradd --system', 'useradd --create-home', 'ssh-keygen -q', 'cp -- "$source_dir/config/config.example.toml"']) {
    assert.ok(install.indexOf(mutation) > call, `${mutation} must follow origin preflight`);
  }
  assert.ok(install.includes('if [[ "$origin_preflight_pending" == 1 ]]; then preflight_admin_origin; fi'));
  assert.ok(install.indexOf('if [[ "$origin_preflight_pending" == 1 ]]') < install.indexOf('for secret_file in'));
});

test('S01 missing fresh-install origin fails clearly before the fixture mutation', linux, t => {
  const { result, mutation } = fixture(t);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Fresh installation requires --admin-origin/);
  assert.equal(existsSync(mutation), false);
});

test('S02 existing-env update preserves the omitted-origin contract and original bytes', linux, t => {
  const { result, envFile, mutation } = fixture(t, { env: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(envFile, 'utf8'), 'existing-fixture-env-preserved\n');
  assert.equal(readFileSync(mutation, 'utf8'), '0');
});

test('S03 explicit HTTPS origin reuses real portal.py dry-run without installation', linux, t => {
  const { result, mutation } = fixture(t, { origin: 'https://approve.example.test:8443' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(mutation, 'utf8'), '0');
  assert.equal(result.stdout, '', 'dry-run plan is suppressed; no install commands execute');
});

for (const origin of ['http://approve.example.test', 'https://user:fixture@approve.example.test', 'https://approve.example.test/path', 'https://approve.example.test?q=fixture', 'https://approve.example.test#fixture', 'https://approve.example.test:99999']) {
  for (const env of [false, true]) {
    test(`S04 refuses invalid explicit origin before mutation (existingEnv=${env}, ${origin})`, linux, t => {
      const { result, envFile, mutation } = fixture(t, { env, origin });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Invalid --admin-origin/);
      assert.equal(existsSync(mutation), false);
      if (env) assert.equal(readFileSync(envFile, 'utf8'), 'existing-fixture-env-preserved\n');
    });
  }
}

test('S05 missing origin fails even when Python is not yet installed', linux, t => {
  const { result, mutation } = fixture(t, { python: false });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Fresh installation requires --admin-origin/);
  assert.equal(existsSync(mutation), false);
});

test('S06 explicit origin defers validation until the existing Python prerequisite installation', linux, t => {
  const { result, mutation } = fixture(t, { origin: 'https://approve.example.test', python: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(mutation, 'utf8'), '1', 'the production caller repeats validation after prerequisites');
});

test('S08 deferred validation runs after Python becomes available and clears the pending flag', linux, t => {
  const { result, mutation } = fixture(t, { origin: 'https://approve.example.test', python: false, afterPrerequisites: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(mutation, 'utf8'), '0');
});

test('S08 deferred invalid origin still stops before runtime/account/SSH fixture mutation', linux, t => {
  const { result, mutation } = fixture(t, { origin: 'http://approve.example.test', python: false, afterPrerequisites: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Invalid --admin-origin/);
  assert.equal(existsSync(mutation), false);
});
