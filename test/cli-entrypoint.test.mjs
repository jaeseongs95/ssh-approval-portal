import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./cli-import.fixture.mjs', import.meta.url));
const windows = process.platform === 'win32';
const scripts = ['manage-secrets', 'verify', 'notices', 'evaluate-safety'];

test('CLI entrypoints execute through the native installer directory link and remain inert on import', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ssh-cli-entrypoint-'));
  const active = join(directory, 'approval-bridge');
  symlinkSync(source, active, windows ? 'junction' : 'dir');
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  try {
    for (const linked of [false, true]) for (const name of scripts) {
      const script = join(linked ? active : source, 'scripts', name + '.mjs');
      await t.test(`${name}: ${linked ? 'installed link' : 'direct path'}`, () => {
        if (name === 'manage-secrets') {
          const result = run([script]);
          assert.equal(result.status, 1);
          assert.deepEqual(JSON.parse(result.stderr), { error: 'invalid_arguments' });
          assert.equal(result.stdout, '');
        } else if (name === 'verify') {
          const result = run([script, directory]);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /release-manifest\.json/);
        } else if (name === 'notices') {
          const root = join(directory, linked ? 'linked-notices' : 'direct-notices');
          mkdirSync(root);
          const output = join(root, 'notices.json');
          const result = run([script, '--root', root, '--output', output]);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout, 'Dependency notice records: 0\n');
          assert.deepEqual(JSON.parse(readFileSync(output)), []);
        } else {
          const result = run([script]);
          assert.equal(result.status, 2);
          assert.match(result.stderr, /^Usage: node scripts\/evaluate-safety\.mjs/);
          assert.equal(result.stdout, '');
        }
      });
    }
    for (const name of scripts) await t.test(`${name}: linked import does not run the CLI`, () => {
      const result = run([fixture, join(active, 'scripts', name + '.mjs')]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).imported, true);
    });
    assert.equal(existsSync(join(directory, 'THIRD_PARTY_NOTICES.json')), false);
  } finally {
    // Remove only the link before recursively removing our own temporary directory.
    if (windows) rmdirSync(active); else unlinkSync(active);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), 'ssh-cli-entrypoint-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
