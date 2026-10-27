import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('rollback refuses a stopped installation before replacing files or restarting', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const result = spawnSync(bash, [resolve('test/rollback-stopped-fixture.sh')], {encoding:'utf8', timeout:30000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
