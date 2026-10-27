import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Compose update rejects malformed image references before Docker, lock, or state mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compose-maintenance-gate-'));
  const sentinel = join(dir, 'docker-called');
  const fakeDocker = join(dir, 'docker');
  await writeFile(fakeDocker, '#!/bin/sh\n: > "$DOCKER_SENTINEL"\n');
  await chmod(fakeDocker, 0o755);
  await writeFile(join(dir, 'id'), '#!/bin/sh\nprintf "0\\n"\n');
  await chmod(join(dir, 'id'), 0o755);
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bash, [fileURLToPath(new URL('../scripts/compose-update.sh', import.meta.url)), 'portal:test;unsafe'], {
        env: { ...process.env, PATH: dir, DOCKER_SENTINEL: sentinel },
      });
      let stderr = ''; child.stderr.on('data', value => stderr += value);
      child.on('error', reject); child.on('close', code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid image reference/);
    await assert.rejects(access(sentinel), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
