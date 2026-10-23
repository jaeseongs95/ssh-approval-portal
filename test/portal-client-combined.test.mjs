import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { main } from '../scripts/portal-client.mjs';

test('output and source-bound upload reject each other\'s options before credentials or HTTP', async t => {
  const originalFetch = globalThis.fetch;
  let helpers = 0, stdin = 0, http = 0;
  globalThis.fetch = async () => { http++; assert.fail('Mixed command options must not reach HTTP'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = { async *[Symbol.asyncIterator]() { stdin++; yield 'SYNTHETIC.PRIVATE.CREDENTIAL'; } };
  const source = resolve('absent-combined-source.bin'), hash = 'a'.repeat(64), id = 'b'.repeat(48);
  const upload = ['upload', source, '/tmp/combined.bin', '--expect-size', '0', '--expect-sha256', hash];
  const variants = [
    ['output', id, '--expect-size', '0', '--expect-sha256', hash],
    ['output', id, '--expect-size', '0'],
    ['output', id, '--expect-sha256', hash],
    ...[['--offset', '0'], ['--limit', '4096'], ['--format', 'text']].map(flags => [...upload, ...flags]),
    [...upload, '--offset', '0', '--help'],
    ['output', id, '--expect-size', '0', '--expect-sha256', hash, '--help'],
  ];
  for (const credentials of [['--access-token-stdin'], ['--cloudflared', source]]) {
    for (const args of variants) {
      let stdout = '', stderr = '';
      const rc = await main(['--origin', 'https://fixture.invalid', ...credentials, ...args], input,
        { write: value => { stdout += value; } }, { write: value => { stderr += value; } },
        () => { helpers++; assert.fail('Mixed command options must not invoke a helper'); });
      assert.equal(rc, 1, args.join(' '));
      assert.equal(stdout, '');
      assert.ok(['INVALID_UPLOAD_EXPECTATION', 'CLI_REQUEST_FAILED'].includes(JSON.parse(stderr).error));
      assert.equal(stderr.includes(source), false);
    }
  }
  assert.deepEqual({ helpers, stdin, http }, { helpers: 0, stdin: 0, http: 0 });
});
