import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('stopped existing installations cannot bypass preservation verification', t => {
  const root = mkdtempSync(join(tmpdir(), 'install-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const script = resolve('scripts/install-state-guard.sh');
  const active = join(root, 'active'), unit = join(root, 'unit'), env = join(root, 'env');
  const run = () => spawnSync(bash, ['-c', 'source "$1"; require_fresh_installation "$2" "$3" "$4"', '_', script, active, unit, env], { encoding: 'utf8' });
  assert.equal(run().status, 0, 'fresh installation must proceed');
  mkdirSync(active);
  assert.equal(run().status, 1, 'existing release must be rejected');
  rmSync(active, { recursive: true });
  writeFileSync(unit, 'existing');
  assert.equal(run().status, 1, 'existing unit must be rejected');
  rmSync(unit);
  writeFileSync(env, 'existing');
  assert.equal(run().status, 1, 'existing configuration must be rejected');
  rmSync(env);
  if (process.platform !== 'win32') {
    symlinkSync(join(root, 'missing'), active);
    assert.equal(run().status, 1, 'dangling installation link must be rejected');
  }
});
