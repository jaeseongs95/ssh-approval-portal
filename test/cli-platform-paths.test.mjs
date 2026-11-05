import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { main } from '../scripts/portal-client.mjs';

const origin = 'https://fixture.invalid', credential = resolve('fixture-cloudflared'), localFile = resolve('fixture-input.bin');
const id = 'a'.repeat(48);
const commands = remotePath => [
  ['request-download', remotePath],
  ['upload', localFile, remotePath],
  ['resume-upload', id, localFile, remotePath],
];

async function validate(args) {
  const output = [], errors = [], calls = [];
  // Stop at the existing credential seam: no process, token, filesystem read or HTTP call.
  const status = await main(['--origin', origin, '--cloudflared', credential, ...args], undefined,
    { write: value => output.push(value) }, { write: value => errors.push(value) },
    (...args) => { calls.push(args); throw Error('PRIVATE_CREDENTIAL_DIAGNOSTIC'); });
  assert.equal(status, 1);
  assert.deepEqual(output, []);
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /PRIVATE_CREDENTIAL_DIAGNOSTIC/);
  return { error: JSON.parse(errors[0]).error, calls };
}

test('CLI upload, resume and download accept Windows and POSIX remote paths before credential acquisition', async () => {
  for (const remotePath of ['C:\\Temp\\file.bin', 'D:/자료/파일 이름.bin', '/tmp/file.bin']) {
    for (const args of commands(remotePath)) {
      const result = await validate(args);
      assert.equal(result.error, 'ACCESS_CREDENTIAL_UNAVAILABLE', JSON.stringify(args));
      assert.equal(result.calls.length, 1, JSON.stringify(args));
      assert.equal(result.calls[0][0], credential);
      assert.deepEqual(result.calls[0][1], ['access', 'token', '--app=' + origin]);
    }
  }
});

test('CLI rejects unsafe Windows and POSIX remote paths before credential acquisition', async () => {
  for (const remotePath of [
    '\\\\server\\share\\file.bin', '\\\\?\\C:\\Temp\\file.bin',
    'C:\\Temp\\file.bin:secret', 'C:\\Temp\\..\\file.bin', 'C:/Temp/./file.bin',
    'C:relative.bin', 'C:\\', 'C:\\Temp\\NUL.txt', 'C:\\Temp\\file.bin ',
    'C:\\Temp\\file\0.bin', '/tmp/../file.bin', '/tmp/./file.bin', 'relative.bin',
  ]) {
    for (const args of commands(remotePath)) {
      const result = await validate(args);
      assert.equal(result.error, 'CLI_REQUEST_FAILED', JSON.stringify(args));
      assert.deepEqual(result.calls, [], JSON.stringify(args));
    }
  }
});
