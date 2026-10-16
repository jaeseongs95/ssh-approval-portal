import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSecretService, parseSecretReference } from '../src/application/secret-service.mjs';
import { readHiddenSecret } from '../src/adapters/secrets/hidden-input.mjs';

test('secret references select a provider without leaking filesystem or vendor assumptions', async () => {
  for (const provider of ['local-file', 'another-vendor']) {
    const service = createSecretService({ [provider]: { read: async name => 'synthetic-' + name } });
    assert.equal(await service.resolve(`secret://${provider}/model-safety`), 'synthetic-model-safety');
  }
  const service = createSecretService({});
  await assert.rejects(service.resolve('secret://unknown/key'), { code: 'provider_unavailable' });
  for (const bad of ['https://example.test/key', 'secret://local-file/../key', 'secret://local-file/%2e%2e', 'secret://local-file/key?query', 'secret://local-file/key/child', 'secret://LOCAL/key', 'secret://local-file/' + 'a'.repeat(65)]) assert.throws(() => parseSecretReference(bad), { code: 'invalid_reference' });
});

test('hidden input emits only prompt/newline and restores terminal state on success and cancellation', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(), writes = [], modes = [];
    input.isTTY = true; input.setRawMode = state => modes.push(state);
    const output = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } }); output.isTTY = true;
    const reading = readHiddenSecret('Secret: ', { input, output });
    input.write(cancel ? '\u0003' : 'synthetic-DO-NOT-ECHO\r');
    if (cancel) await assert.rejects(reading, { code: 'input_cancelled' });
    else assert.equal(await reading, 'synthetic-DO-NOT-ECHO');
    assert.equal(writes.join(''), 'Secret: \n');
    assert.deepEqual(modes, [true, false]); input.destroy(); output.destroy();
  }
  await assert.rejects(readHiddenSecret('Secret: ', { input: new PassThrough(), output: new PassThrough() }), { code: 'terminal_required' });
  for (const brokenOutput of [false, true]) {
    const input = new PassThrough(), modes = []; input.isTTY = true; input.setRawMode = state => modes.push(state);
    const output = new Writable({ write(_chunk, _encoding, done) { done(brokenOutput ? Error('synthetic-output-failed') : undefined); } }); output.isTTY = true;
    const reading = readHiddenSecret('Secret: ', { input, output });
    if (!brokenOutput) input.end();
    await assert.rejects(reading, { code: 'input_cancelled' }); assert.deepEqual(modes, [true, false]);
    input.destroy(); output.destroy();
  }
});

test('actual CLI rejects piped secret bytes and value arguments without echoing them', () => {
  const marker = 'synthetic-secret-cli-must-not-print';
  const script = new URL('../scripts/manage-secrets.mjs', import.meta.url);
  for (const extra of [[], ['--value', marker]]) {
    const args = ['--store', process.platform === 'win32' ? 'C:\\private-fixture-store' : '/private-fixture-store', 'set', 'secret://local-file/model-key', ...extra];
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { input: marker + '\n', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
    assert.match(result.stderr, /terminal_required|invalid_arguments/);
  }
});
