import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installer preflight refusal precedes provisioning or service mutation', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'install-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts'), bin = join(root, 'bin');
  mkdirSync(scripts); mkdirSync(bin);
  copyFileSync(resolve('scripts/install.sh'), join(scripts, 'install.sh'));
  const sentinel = join(root, 'environment'), log = join(root, 'mutations');
  writeFileSync(sentinel, 'preserved secret configuration\n');
  writeFileSync(join(bin, 'id'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\n[ "$4" = preflight ] || exit 99\necho "Existing installation: use portal.py deploy plan/apply/status/resume." >&2\nexit 23\n', { mode: 0o755 });
  for (const name of ['install', 'apt-get', 'systemctl', 'docker', 'useradd', 'ssh-keygen', 'node', 'cp', 'mv', 'rm', 'chmod', 'chown']) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho "unexpected mutation" >> "$MUTATION_LOG"\nexit 77\n', { mode: 0o755 });
  }
  const result = spawnSync('/bin/bash', [join(scripts, 'install.sh'), '--manifest-sha256', 'a'.repeat(64)], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: bin + ':' + process.env.PATH, MUTATION_LOG: log },
  });
  assert.equal(result.status, 23, result.stderr || result.error?.message);
  assert.match(result.stderr, /deploy plan\/apply\/status\/resume/);
  assert.equal(existsSync(log), false, 'no provisioning or service command may run after refusal');
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserved secret configuration\n');
});
