import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';

const posix = { skip: !process.geteuid && 'Requires POSIX ownership and modes' };
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'ssh-secret-io-'));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'store'), store = createLocalSecretStore(directory);
  await store.init(); await store.put('key', 'synthetic-old');
  return { parent, directory, store, previous: await store.describe('key') };
}
const ioError = () => Object.assign(new Error('Synthetic I/O failure'), { code: 'EIO' });
function handleOverride(handle, overrides) {
  return new Proxy(handle, { get(target, key) { return overrides[key] ?? (typeof target[key] === 'function' ? target[key].bind(target) : target[key]); } });
}

test('untrusted writable ancestors are refused before init, read, put and delete', posix, async t => {
  const { parent, directory, store } = await fixture(t);
  const privateParent = path.join(parent, 'private'); await fs.mkdir(privateParent, { mode: 0o700 });
  const nested = createLocalSecretStore(path.join(privateParent, 'nested')); await nested.init(); await nested.put('key', 'synthetic-old');
  await fs.chmod(parent, 0o777);
  try {
    for (const operation of [() => nested.init(), () => nested.read('key'), () => nested.put('key', 'synthetic-new'), () => nested.remove('key')]) {
      await assert.rejects(operation(), { code: 'unsafe_store' });
    }
  } finally { await fs.chmod(parent, 0o700); }
  if (process.geteuid() === 0) {
    await fs.chown(parent, 12345, 12345);
    try { await assert.rejects(nested.put('key', 'synthetic-new'), { code: 'unsafe_store' }); }
    finally { await fs.chown(parent, 0, 0); }
  }
  assert.equal(await nested.read('key'), 'synthetic-old');
  assert.equal(await store.read('key'), 'synthetic-old');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.gitignore', 'key.json']);
});

for (const stage of ['write', 'file-sync', 'rename']) {
  test(`pre-commit ${stage} failure preserves old revision and cleans staging files`, posix, async t => {
    const { directory, store, previous } = await fixture(t);
    const open = fs.open, rename = fs.rename;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (!path.basename(file).startsWith('.pending-')) return handle;
      return handleOverride(handle, stage === 'write' ? { writeFile: async () => { await handle.write('partial'); throw ioError(); } } : stage === 'file-sync' ? { sync: async () => { throw ioError(); } } : {});
    });
    if (stage === 'rename') t.mock.method(fs, 'rename', async (...args) => { if (path.basename(args[0]).startsWith('.pending-')) throw ioError(); return rename(...args); });
    await assert.rejects(store.put('key', 'synthetic-new'), { code: 'EIO' });
    assert.equal(await store.read('key'), 'synthetic-old'); assert.deepEqual(await store.describe('key'), previous);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['.gitignore', 'key.json']);
  });
}

for (const action of ['put', 'remove']) {
  test(`post-commit directory sync failure during ${action} reports commit_uncertain`, posix, async t => {
    const { directory, store, previous } = await fixture(t), open = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      return file === directory ? handleOverride(handle, { sync: async () => { throw ioError(); } }) : handle;
    });
    await assert.rejects(action === 'put' ? store.put('key', 'synthetic-new') : store.remove('key'), { code: 'commit_uncertain' });
    assert.equal(await store.read('key'), action === 'put' ? 'synthetic-new' : undefined);
    if (action === 'put') assert.notEqual((await store.describe('key')).revision, previous.revision);
    assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.pending-') || name === '.write-lock'));
  });
}

test('cleanup errors preserve primary failure and successful commit is reported uncertain', posix, async t => {
  const { directory, store } = await fixture(t), rename = fs.rename, unlink = fs.unlink;
  let failBeforeCommit = true;
  t.mock.method(fs, 'rename', async (...args) => { if (failBeforeCommit) throw ioError(); return rename(...args); });
  t.mock.method(fs, 'unlink', async file => { if (path.basename(file).startsWith('.pending-') || path.basename(file) === '.write-lock') throw Object.assign(new Error('Synthetic cleanup failure'), { code: 'EACCES' }); return unlink(file); });
  await assert.rejects(store.put('key', 'synthetic-new'), { code: 'EIO' });
  assert.equal(await store.read('key'), 'synthetic-old');
  assert.ok((await fs.readdir(directory)).some(name => name.startsWith('.pending-')));
  await assert.rejects(store.put('key', 'synthetic-new'), { code: 'store_busy' });
  // This fixture owns the failed writer and its exact staging paths.
  for (const name of await fs.readdir(directory)) if (name.startsWith('.pending-') || name === '.write-lock') await unlink(path.join(directory, name));
  failBeforeCommit = false;
  await assert.rejects(store.put('key', 'synthetic-new'), { code: 'commit_uncertain' });
  assert.equal(await store.read('key'), 'synthetic-new');
  await assert.rejects(store.remove('key'), { code: 'store_busy' });
});

test('lock cleanup failure cannot mask post-commit uncertainty', posix, async t => {
  const { directory, store } = await fixture(t), open = fs.open, unlink = fs.unlink;
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    return file === directory ? handleOverride(handle, { sync: async () => { throw ioError(); } }) : handle;
  });
  t.mock.method(fs, 'unlink', async file => { if (path.basename(file) === '.write-lock') throw ioError(); return unlink(file); });
  await assert.rejects(store.put('key', 'synthetic-new'), { code: 'commit_uncertain' });
  assert.equal(await store.read('key'), 'synthetic-new');
  await assert.rejects(store.put('key', 'synthetic-next'), { code: 'store_busy' });
});

test('killed staged writer preserves old complete record and stale lock blocks later writes', posix, async t => {
  const { directory, store, previous } = await fixture(t);
  const child = fork(new URL('./secret-writer.fixture.mjs', import.meta.url), [], { silent: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const staged = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  child.send({ directory, value: 'synthetic-new', interrupt: true });
  assert.deepEqual((await staged)[0], { staged: true });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
  assert.doesNotMatch(output, /synthetic-/);
  assert.equal(await store.read('key'), 'synthetic-old'); assert.deepEqual(await store.describe('key'), previous);
  const pending = (await fs.readdir(directory)).filter(name => name.startsWith('.pending-'));
  assert.equal(pending.length, 1); assert.equal((await fs.stat(path.join(directory, pending[0]))).mode & 0o777, 0o600);
  await assert.rejects(store.put('key', 'synthetic-next'), { code: 'store_busy' });
  await assert.rejects(store.remove('key'), { code: 'store_busy' });
});
