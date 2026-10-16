import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalSecretStore } from '../src/adapters/secrets/local-file.mjs';
import { runSecretCommand } from '../scripts/manage-secrets.mjs';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const posix = { skip: !process.getuid && 'POSIX ownership and private modes require a native POSIX test host' };
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'ssh-secret-'));
  await fs.chmod(parent, 0o700);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'store'), store = createLocalSecretStore(directory);
  await store.init(); return { parent, directory, store };
}

test('private local store registers, rotates, resolves and removes while metadata excludes value', posix, async t => {
  const { directory, store } = await fixture(t), marker = 'synthetic-secret-only-provider-read';
  const first = await store.put('model-key', marker);
  assert.equal(await store.read('model-key'), marker);
  assert.deepEqual(Object.keys(first).sort(), ['name', 'revision', 'updatedAt']);
  const second = await store.put('model-key', 'synthetic-rotated');
  assert.notEqual(second.revision, first.revision); assert.equal(await store.read('model-key'), 'synthetic-rotated');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'model-key.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify([first, await store.describe('model-key'), await store.list()]), /synthetic-/);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'model-key.json'), 'utf8'));
  await fs.writeFile(path.join(directory, 'model-key.json'), JSON.stringify({ ...stored, unknownField: marker }));
  assert.doesNotMatch(JSON.stringify([await store.describe('model-key'), await store.list()]), /synthetic-/);
  const parent = path.dirname(directory);
  for (const args of [['init', '--quiet'], ['add', '.'], ['status', '--porcelain']]) {
    const result = spawnSync('git', args, { cwd: parent, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0); if (args[0] === 'status') assert.equal(result.stdout.trim(), '');
  }
  assert.deepEqual(await store.remove('model-key'), { name: 'model-key', removed: true });
  assert.equal(await store.read('model-key'), undefined); assert.deepEqual(await store.remove('model-key'), { name: 'model-key', removed: false });
});

test('unsafe permissions, symlinks, hardlinks, corruption and oversized records fail closed', posix, async t => {
  const { parent, directory, store } = await fixture(t), file = path.join(directory, 'key.json');
  await store.put('key', 'synthetic-value');
  const marker = path.join(directory, '.gitignore');
  await fs.chmod(marker, 0o644); await assert.rejects(store.read('key'), { code: 'unsafe_store' }); await fs.chmod(marker, 0o600);
  if (process.getuid() === 0) { await fs.chown(file, 12345, 12345); await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await fs.chown(file, 0, 0); }
  await fs.chmod(file, 0o644); await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await fs.chmod(file, 0o600);
  const linked = path.join(parent, 'hardlink'); await fs.link(file, linked);
  await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await fs.unlink(linked);
  await fs.rename(file, path.join(parent, 'original')); await fs.symlink(path.join(parent, 'original'), file);
  await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await assert.rejects(store.put('key', 'replacement'), { code: 'unsafe_record' }); await fs.unlink(file);
  await fs.writeFile(file, 'synthetic-bad-record', { mode: 0o600 }); await assert.rejects(store.read('key'), error => error.code === 'invalid_record' && !error.message.includes('synthetic-bad-record'));
  await fs.writeFile(file, 'a'.repeat(32769)); await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await fs.unlink(file);
  await fs.mkdir(file); await assert.rejects(store.read('key'), { code: 'unsafe_record' }); await fs.rmdir(file);
  const alias = path.join(parent, 'alias'); await fs.symlink(directory, alias);
  await assert.rejects(createLocalSecretStore(alias).init(), { code: 'unsafe_store' });
  await assert.rejects(store.put('../escape', 'value'), { code: 'invalid_reference' });
  await assert.rejects(store.put('key', '\u0001'.repeat(16384)), { code: 'invalid_value' });
  await fs.chmod(directory, 0o750); await assert.rejects(store.read('key'), { code: 'unsafe_store' }); await fs.chmod(directory, 0o700);
  await fs.chmod(parent, 0o750); await assert.rejects(store.read('key'), { code: 'unsafe_store' }); await fs.chmod(parent, 0o700);
});

test('exclusive writer lock refuses overlap and stale locks while committed readers see complete records', posix, async t => {
  const { directory, store } = await fixture(t);
  await store.put('key', 'synthetic-old');
  const lock = path.join(directory, '.write-lock'); await fs.writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  await assert.rejects(store.put('key', 'synthetic-forbidden'), { code: 'store_busy' });
  await assert.rejects(store.remove('key'), { code: 'store_busy' }); assert.equal(await store.read('key'), 'synthetic-old');
  await fs.unlink(lock);
  const next = 'synthetic-new'.repeat(1000), writing = store.put('key', next);
  const values = await Promise.all(Array.from({ length: 12 }, () => store.read('key')));
  await writing;
  assert.ok(values.every(value => value === 'synthetic-old' || value === next));
  assert.equal(await store.read('key'), next);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.gitignore', 'key.json']);
});

test('CLI set/rotation/status/list/delete show metadata only and mismatched confirmation preserves prior value', posix, async t => {
  const { directory, store } = await fixture(t), output = [], reference = 'secret://local-file/model-key';
  const invoke = (action, options = {}) => runSecretCommand(['--store', directory, action, ...(['list', 'init'].includes(action) ? [] : [reference])], { write: value => output.push(value), ...options });
  await invoke('set', { readValue: async () => 'synthetic-cli-value' });
  await invoke('status'); await invoke('list');
  assert.equal(await store.read('model-key'), 'synthetic-cli-value');
  let count = 0; await assert.rejects(invoke('set', { readValue: async () => count++ ? 'synthetic-mismatch' : 'synthetic-first' }), { code: 'confirmation_mismatch' });
  assert.equal(await store.read('model-key'), 'synthetic-cli-value');
  assert.doesNotMatch(JSON.stringify(output), /synthetic-/);
  await invoke('delete'); assert.equal(await store.read('model-key'), undefined);
});

test('independent writer processes honor the filesystem claim and leave one complete committed record', posix, async t => {
  const { directory, store } = await fixture(t);
  await store.put('key', 'synthetic-old');
  const writer = value => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./secret-writer.fixture.mjs', import.meta.url)), [], { silent: true });
    let output = '', message;
    const timer = setTimeout(() => { child.kill(); reject(Error('Owned fixture timed out')); }, 5000);
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('message', value => { message = value; });
    child.once('exit', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0); assert.ok(message); assert.doesNotMatch(output + JSON.stringify(message), /synthetic-/); resolve(message); }
      catch (error) { reject(error); }
    });
    child.send({ directory, value });
  });
  const lock = path.join(directory, '.write-lock'); await fs.writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await Promise.all([writer('synthetic-one'), writer('synthetic-two')]), [{ ok: false, code: 'store_busy' }, { ok: false, code: 'store_busy' }]);
  assert.equal(await store.read('key'), 'synthetic-old'); await fs.unlink(lock);
  const results = await Promise.all([writer('synthetic-one'), writer('synthetic-two')]);
  assert.ok(results.some(result => result.ok)); assert.ok(results.every(result => result.ok || result.code === 'store_busy'));
  assert.ok(['synthetic-one', 'synthetic-two'].includes(await store.read('key')));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.gitignore', 'key.json']);
});
