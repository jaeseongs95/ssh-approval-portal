import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestServerMode } from '../src/application/test-server-mode.mjs';

test('test server secret checks fail closed, use the existing resolver, and never cache capability', async () => {
  let value = 'a'.repeat(64), calls = 0;
  const resolver = { resolve: async () => { calls++; return value; } };
  for (const reference of ['', undefined, 'arbitrary', 'secret://local-file/../bad']) {
    const mode = createTestServerMode({ reference, resolver });
    assert.equal(await mode.available(), false);
    await assert.rejects(mode.require(), /capability unavailable/);
  }
  assert.equal(calls, 0);
  const mode = createTestServerMode({ reference: 'secret://local-file/test-server', resolver });
  assert.equal(await mode.available(), true);
  for (const missing of [undefined, '', 'not-a-valid-marker', 1, null]) {
    value = missing; assert.equal(await mode.available(), false);
    await assert.rejects(mode.require(), /capability unavailable/);
  }
  value = 'b'.repeat(64); await mode.require();
  const unavailable = createTestServerMode({ reference: 'secret://vault/test-server', resolver: { resolve: async () => { throw Error('private provider details'); } } });
  await assert.rejects(unavailable.require(), error => error.message === 'Test server capability unavailable');
});
