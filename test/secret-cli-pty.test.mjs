import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual Linux TTY registers, rotates and cancels without echoing synthetic values', { skip: process.platform !== 'linux' && 'Linux PTY integration is verified on the native POSIX runner' }, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./secret_cli_pty_fixture.py', import.meta.url)), process.execPath,
    fileURLToPath(new URL('../scripts/manage-secrets.mjs', import.meta.url))], { encoding: 'utf8', timeout: 35000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /TTY register\/rotate\/cancel: PASS/);
});
