import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('removed rollback command refuses every invocation without touching services or data', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'rollback-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'mutations'), sentinel = join(root, 'generation');
  writeFileSync(sentinel, 'current database generation\n');
  for (const name of ['id', 'realpath', 'cp', 'mv', 'rm', 'ln', 'flock', 'systemctl', 'node', 'python3', 'curl']) {
    writeFileSync(join(root, name), '#!/bin/sh\necho "unexpected command" >> "$MUTATION_LOG"\nexit 77\n', { mode: 0o755 });
  }
  for (const args of [[], ['/var/lib/ssh-mcp/app/backups/old'], ['--help']]) {
    const result = spawnSync('/bin/bash', [resolve('scripts/rollback.sh'), ...args], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: root, MUTATION_LOG: log },
    });
    assert.equal(result.status, 1, result.stderr || result.error?.message);
    assert.match(result.stderr, /portal\.py deploy status JOB_ID/);
    assert.match(result.stderr, /portal\.py deploy resume JOB_ID/);
    assert.equal(existsSync(log), false, 'removed command must have no external effects');
    assert.equal(readFileSync(sentinel, 'utf8'), 'current database generation\n');
  }
});
