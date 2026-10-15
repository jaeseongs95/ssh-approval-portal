import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApprovalQueue } from '../src/domain/approval-queue.mjs';
import { Artifacts } from '../src/adapters/storage/artifacts.mjs';
import { createFileService } from '../src/application/files.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
async function files(path) {
  const found = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.isDirectory()) found.push(...await files(join(path, item.name)));
    else if (item.name.endsWith('.mjs')) found.push(join(path, item.name));
  }
  return found;
}
test('ARCH-01 domain/application dependencies point inward and never expose host DTOs or store writes', async () => {
  for (const area of ['domain', 'application']) for (const file of await files(join(root, 'src', area))) {
    const text = await readFile(file, 'utf8');
    const imports = [...text.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const specifier of imports) {
      if (area === 'domain' && specifier === 'node:crypto') continue;
      assert.ok(specifier.startsWith('.'), `${area} must not import infrastructure ${specifier}`);
      const target = resolve(dirname(file), specifier);
      const allowed = ['contracts', 'domain', ...(area === 'application' ? ['application'] : [])];
      assert.ok(allowed.some(folder => target.startsWith(resolve(root, 'src', folder) + (process.platform === 'win32' ? '\\' : '/'))), 'An inward layer imports an outward adapter');
    }
    assert.doesNotMatch(text, /\b(?:structuredContent|_meta|download_url|file_id|statusCode)\b/, 'Transport DTO leaked into an inward layer');
    assert.doesNotMatch(text, /\bstore\.(?:items|reserved|pinned|state)\b/, 'Application observes or mutates store internals');
  }
});
test('PORT-01 stream and async-iterator FileSource substitutes preserve approval and byte contracts', async () => {
  const payload = Buffer.from([0, 255, 1, 2]);
  const digest = createHash('sha256').update(payload).digest('hex');
  for (const kind of ['readable-stream', 'async-iterator']) {
    const directory = await mkdtemp(join(tmpdir(), 'solid-port-'));
    try {
      const store = new Artifacts(directory, { maxBytes: 16, budget: 32 }); await store.init();
      let service, executions = 0, closes = 0;
      const queue = new ApprovalQueue({ classify: () => ({ class: 'safe' }), profile: 'fixture-write', target: 'fixture-target', executeOperation: async () => { executions++; return { failed: false, texts: ['done'] }; }, onTerminal: job => service.onTerminal(job) });
      service = createFileService({ store, queue, transfers: {} });
      const source = { inspect: () => ({ allowed: true, sourceHost: 'files.example.test' }), open: async () => ({
        stream: kind === 'readable-stream' ? Readable.from([payload]) : (async function* () { yield payload.subarray(0, 2); yield payload.subarray(2); })(),
        expectedSize: kind === 'readable-stream' ? payload.length : null, close() { closes++; },
      }) };
      const value = await service.requestUpload({ source, fileName: 'fixture.bin', remotePath: '/tmp/fixture.bin' });
      assert.equal(value.type, 'job'); assert.equal(value.job.state, 'pending');
      assert.equal(value.job.operation.sha256, digest); assert.equal(value.job.operation.size, payload.length);
      assert.equal(executions, 0); assert.equal(closes, 1);
      const finished = await queue.approve(value.job.id); assert.equal(finished.state, 'completed'); assert.equal(executions, 1);
      assert.throws(() => queue.start(value.job.id));
      await store.reap(); assert.equal(store.hasActiveWork(), false); assert.equal(store.reserved, 0);
      await service.close();
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('PORT-02 default staging budget reserves eight 64MiB files without allocating their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'solid-budget-'));
  try {
    const store = new Artifacts(directory); await store.init();
    assert.equal(store.maxBytes, 64 * 1024 * 1024); assert.equal(store.budget, 512 * 1024 * 1024);
    const ids = [];
    const meta = { fileName: 'fixture.bin', remotePath: '/tmp/fixture.bin', size: store.maxBytes, sha256: '0'.repeat(64) };
    for (let index = 0; index < 8; index++) ids.push((await store.begin(meta)).id);
    assert.equal(store.reserved, store.budget); assert.equal(store.size, 8);
    await assert.rejects(store.begin(meta), /Staging budget exhausted/);
    assert.equal(store.reserved, store.budget); assert.equal(store.size, 8);
    for (const id of ids) await store.remove(id);
    assert.equal(store.reserved, 0); assert.equal(store.size, 0); assert.equal(store.hasActiveWork(), false);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
    await rm(directory, { recursive: true, force: true });
  }
});
