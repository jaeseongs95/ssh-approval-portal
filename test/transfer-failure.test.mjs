import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { Transfers } from '../src/adapters/ssh/transfers.mjs';
import { hash } from '../src/domain/validation.mjs';

test('failed SSH connection releases reserved download quota and creates no local payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ssh-disconnect-'));
  try {
    const artifacts = new Artifacts(root, { maxBytes: 32, budget: 32 }); await artifacts.init();
    const transfers = new Transfers({ getOrCreate: async () => { throw Error('synthetic disconnect'); } }, artifacts);
    await assert.rejects(transfers.download({ kind: 'download', remotePath: '/tmp/x', elevate: false }));
    assert.equal(artifacts.reserved, 0); assert.equal(artifacts.size, 0);
  } finally { await rm(root, { recursive: true }); }
});

const bytes = Buffer.from([0, 255, 1, 128]);
async function fixture({ uploadError = false, downloadError = false, wrongHash = false, cleanupError = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-transport-contract-'));
  const store = new Artifacts(root, { maxBytes: 16, budget: 16 }); await store.init();
  const calls = [], profiles = [], uploaded = [];
  const transport = { connect: async profile => {
    profiles.push(profile);
    return {
      async call(command, payload) {
        calls.push({ command, payload });
        if (payload.action === 'cleanup' && cleanupError) throw Error('cleanup disconnected');
        const data = payload.action === 'snapshot' ? { size: bytes.length, sha256: wrongHash ? '0'.repeat(64) : hash(bytes) } :
          payload.action === 'publish' ? { published: true, size: bytes.length, sha256: hash(bytes) } : { cleaned: true };
        return { exitCode: 0, stdout: JSON.stringify(data) };
      },
      async upload(stream, remotePath, bounds) {
        assert.match(remotePath, /\/[a-f0-9]{48}\.part$/); assert.equal(bounds.maxBytes, 16);
        for await (const chunk of stream) uploaded.push(chunk);
        if (uploadError) throw Error('upload disconnected');
      },
      async download(remotePath, destination, bounds) {
        assert.match(remotePath, /\/[a-f0-9]{48}\.part$/); assert.equal(bounds.maxBytes, 16);
        if (downloadError) throw Error('download disconnected');
        destination.end(bytes);
      },
    };
  } };
  const transfers = new Transfers(null, store, { readProfile: 'reader', writeProfile: 'writer', transport });
  return { store, transfers, calls, profiles, uploaded, root, close: () => rm(root, { recursive: true }) };
}

test('upload transport streams exact binary and invokes sudo helper with frozen approved metadata, then unprivileged cleanup', async () => {
  const f = await fixture();
  try {
    const item = await f.store.begin({ fileName: 'binary.zip', remotePath: '/root/binary.zip', size: 4, sha256: hash(bytes), overwrite: true, elevate: true });
    await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
    const operation = { kind: 'upload', artifactId: item.id, remotePath: '/root/binary.zip', size: 4, sha256: hash(bytes), overwrite: true, elevate: true };
    await assert.rejects(f.transfers.upload({ ...operation, overwrite: false }), /frozen/); assert.equal(f.profiles.length, 0);
    const outcome = await f.transfers.upload(operation);
    assert.deepEqual(Buffer.concat(f.uploaded), bytes); assert.deepEqual(f.profiles, ['writer']);
    assert.equal(outcome.failed, false); assert.deepEqual(outcome.texts, ['Upload completed']); assert.equal(outcome.content, undefined);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['publish', 'cleanup']);
    assert.match(f.calls[0].command, /^sudo -n /); assert.doesNotMatch(f.calls[1].command, /^sudo /);
    assert.equal(f.calls[0].payload.overwrite, true); assert.equal(f.calls[0].payload.sha256, hash(bytes)); assert.equal(f.calls[0].payload.maxBytes, 16);
  } finally { await f.close(); }
});

test('upload failure makes one attempt, never publishes and still attempts cleanup', async () => {
  const f = await fixture({ uploadError: true, cleanupError: true });
  try {
    const item = await f.store.begin({ fileName: 'x', remotePath: '/tmp/x', size: 4, sha256: hash(bytes) });
    await f.store.append(item.id, 0, bytes); await f.store.finish(item.id);
    await assert.rejects(f.transfers.upload({ artifactId: item.id, remotePath: '/tmp/x', size: 4, sha256: hash(bytes), overwrite: false, elevate: false }), /upload disconnected/);
    assert.deepEqual(f.calls.map(x => x.payload.action), ['cleanup']); assert.deepEqual(f.profiles, ['writer']);
  } finally { await f.close(); }
});

test('download transport chooses privilege profile, retains exact binary and returns neutral metadata', async () => {
  for (const elevate of [false, true]) {
    const f = await fixture();
    try {
      const outcome = await f.transfers.download({ remotePath: '/tmp/한글.zip', elevate });
      assert.deepEqual(f.profiles, [elevate ? 'writer' : 'reader']); assert.equal(outcome.failed, false); assert.equal(outcome.data.fileName, '한글.zip');
      assert.equal(outcome.data.size, 4); assert.equal(outcome.data.sha256, hash(bytes)); assert.equal(outcome.structuredContent, undefined);
      const fd = await f.store.verified(outcome.data.artifactId);
      const received = Buffer.alloc(4); try { await fd.read(received, 0, 4, 0); } finally { await fd.close(); }
      assert.deepEqual(received, bytes); assert.equal(f.store.reserved, 4); assert.equal(f.store.hasActiveWork(), false);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['snapshot', 'cleanup']);
      assert.equal(f.calls[0].command.startsWith('sudo -n '), elevate); assert.doesNotMatch(f.calls[1].command, /^sudo /);
    } finally { await f.close(); }
  }
});

test('download transfer and hash failures clean local quota and attempt remote cleanup without retry', async () => {
  for (const options of [{ downloadError: true }, { wrongHash: true }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(f.transfers.download({ remotePath: '/tmp/x', elevate: false }));
      assert.equal(f.store.reserved, 0); assert.equal(f.store.size, 0); assert.deepEqual(await readdir(f.root), []);
      assert.deepEqual(f.calls.map(x => x.payload.action), ['snapshot', 'cleanup']); assert.deepEqual(f.profiles, ['reader']);
    } finally { await f.close(); }
  }
});
