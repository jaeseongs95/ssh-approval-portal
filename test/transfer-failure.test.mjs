import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../artifacts.mjs';
import { Transfers } from '../transfers.mjs';

test('failed SSH connection releases reserved download quota and creates no local payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-disconnect-'));
  try {
    const artifacts = new Artifacts(root, { maxBytes: 32, budget: 32 }); await artifacts.init();
    const transfers = new Transfers({ getOrCreate: async () => { throw Error('synthetic disconnect'); } }, artifacts);
    await assert.rejects(transfers.download({ kind: 'download', remotePath: '/tmp/x', elevate: false }));
    assert.equal(artifacts.reserved, 0); assert.equal(artifacts.items.size, 0);
  } finally { await rm(root, { recursive: true }); }
});
