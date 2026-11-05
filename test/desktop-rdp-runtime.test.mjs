import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const linux = { skip: process.platform !== 'linux' };
const upstream = 'bf217a504e54cc719880c228e82353382cd7d4fa';
const patchDigest = 'c'.repeat(64);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const native = { protocol: 'ags-native-input/1', upstreamCommit: upstream, patchDigest };

// Public API + real filesystem/process boundary. The shell executable is a protocol
// probe fixture; it does not model FreeRDP, ELF dependency resolution or Windows GUI.
async function fixture(t, { probeOutput = JSON.stringify(native), probeExit = 0 } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'portal-rdp-runtime-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const module = join(folder, 'src/adapters/desktop/rdp-runtime.mjs');
  const root = join(folder, 'native/freerdp-input/runtime');
  const executable = join(root, 'bin/xfreerdp3'), marker = join(folder, 'probe-called'), homeMarker = join(folder, 'probe-home');
  await mkdir(dirname(module), { recursive: true });
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(join(root, 'lib'), { recursive: true });
  await copyFile(new URL('../src/adapters/desktop/rdp-runtime.mjs', import.meta.url), module);
  const script = Buffer.from(`#!/bin/sh
printf called >> ${shellQuote(marker)}
printf '%s' "$HOME" > ${shellQuote(homeMarker)}
[ "$#" -eq 1 ] && [ "$1" = /ags-input-capabilities ] || exit 41
[ "$PATH" = /usr/bin:/bin ] && [ "$LANG" = C.UTF-8 ] || exit 42
[ -z "\${AGS_RUNTIME_PROBE_SENTINEL+x}" ] && [ -z "\${DISPLAY+x}" ] || exit 43
[ -d "$HOME" ] && [ "$XDG_CONFIG_HOME" = "$HOME" ] && [ "$XDG_CACHE_HOME" = "$HOME" ] && [ "$XDG_RUNTIME_DIR" = "$HOME" ] || exit 44
printf '%s' ${shellQuote(probeOutput)}
exit ${probeExit}
`);
  const library = Buffer.from('private-library-fixture\n');
  await writeFile(executable, script, { mode: 0o755 });
  await chmod(executable, 0o755);
  await writeFile(join(root, 'lib/libfreerdp-fixture.so'), library, { mode: 0o644 });
  await chmod(join(root, 'lib/libfreerdp-fixture.so'), 0o644);
  const manifest = { format: 'portal.freerdp-native.v1', upstreamVersion: '3.32.1', upstreamCommit: upstream,
    patchSha256: patchDigest, executable: 'bin/xfreerdp3', files: [
      { path: 'bin/xfreerdp3', size: script.length, sha256: sha256(script), mode: 0o755 },
      { path: 'lib/libfreerdp-fixture.so', size: library.length, sha256: sha256(library), mode: 0o644 },
    ] };
  const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await save();
  const api = await import(pathToFileURL(module).href);
  return { ...api, folder, root, executable, marker, homeMarker, manifest, save,
    async assertNotProbed() { assert.equal(await exists(marker), false, 'verification failure must precede executable dispatch'); },
  };
}

function unavailable(result, reason) {
  assert.deepEqual(result, { available: false, executable: null, reason });
}

test('private runtime verifies all declared files and runs exact standalone probe with isolated environment', linux, async t => {
  const f = await fixture(t);
  const previous = { sentinel: process.env.AGS_RUNTIME_PROBE_SENTINEL, display: process.env.DISPLAY };
  process.env.AGS_RUNTIME_PROBE_SENTINEL = 'test-only-inherited-value'; process.env.DISPLAY = ':unexpected';
  try {
    assert.equal(f.nativeRdpExecutable, f.executable);
    assert.deepEqual(await f.readNativeRdpCapabilities(), { available: true, executable: f.executable,
      executableSha256: f.manifest.files[0].sha256, patchDigest });
  } finally {
    for (const [key, value] of [['AGS_RUNTIME_PROBE_SENTINEL', previous.sentinel], ['DISPLAY', previous.display]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(await readFile(f.marker, 'utf8'), 'called');
  const home = await readFile(f.homeMarker, 'utf8');
  assert.notEqual(home, process.env.HOME); assert.equal(await exists(home), false, 'probe HOME is removed after success');
});

test('capability object requires exact private path and upstream/patch/protocol binding', linux, async t => {
  const f = await fixture(t);
  const valid = { platform: 'linux', executable: f.executable, executableSha256: 'b'.repeat(64), patchDigest, native };
  assert.equal(f.nativeRdpCapabilities(valid).available, true);
  for (const mutation of [
    { platform: 'win32' }, { executable: '/usr/bin/xfreerdp3' }, { executable: f.executable + '.other' },
    { executableSha256: undefined }, { executableSha256: 'B'.repeat(64) }, { patchDigest: 'bad' },
    { native: { ...native, patchDigest: 'd'.repeat(64) } }, { native: { ...native, upstreamCommit: '0'.repeat(40) } },
    { native: { ...native, protocol: 'ags-native-input/2' } }, { native: { ...native, unexpected: true } },
    { native: [] }, { native: null },
  ]) assert.deepEqual(f.nativeRdpCapabilities({ ...valid, ...mutation }), { available: false, executable: null });
  await f.assertNotProbed();
});

test('missing manifest or private executable fails closed without stock-client fallback', linux, async t => {
  for (const path of ['manifest.json', 'bin/xfreerdp3']) await t.test(path, async t => {
    const f = await fixture(t); await rm(join(f.root, path));
    unavailable(await f.readNativeRdpCapabilities(), 'DESKTOP_RDP_NATIVE_MISSING'); await f.assertNotProbed();
  });
});

test('manifest rejects version, upstream, digest, executable and file-list contract violations before probe', linux, async t => {
  const cases = [
    ['format', m => { m.format = 'other'; }], ['version', m => { m.upstreamVersion = '3.32.2'; }],
    ['upstream', m => { m.upstreamCommit = '0'.repeat(40); }], ['patch digest', m => { m.patchSha256 = 'bad'; }],
    ['stock executable', m => { m.executable = '/usr/bin/xfreerdp3'; }], ['empty files', m => { m.files = []; }],
    ['missing executable entry', m => { m.files.shift(); }], ['duplicate entry', m => { m.files.push({ ...m.files[0] }); }],
    ['path traversal', m => { m.files[0].path = '../xfreerdp3'; }], ['absolute path', m => { m.files[0].path = '/tmp/xfreerdp3'; }],
    ['empty segment', m => { m.files[0].path = 'bin//xfreerdp3'; }], ['file digest', m => { m.files[0].sha256 = 'bad'; }],
    ['zero size', m => { m.files[0].size = 0; }], ['oversize file', m => { m.files[0].size = 32 * 1024 * 1024 + 1; }],
    ['invalid mode', m => { m.files[0].mode = 0o1777; }], ['too many files', m => { m.files = Array(257).fill(m.files[0]); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await fixture(t); mutate(f.manifest); await f.save();
    unavailable(await f.readNativeRdpCapabilities(), 'DESKTOP_RDP_NATIVE_MANIFEST'); await f.assertNotProbed();
  });
});

test('manifest size bound is enforced before parsing or probing', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'manifest.json'), ' '.repeat(131073));
  unavailable(await f.readNativeRdpCapabilities(), 'DESKTOP_RDP_NATIVE_MANIFEST'); await f.assertNotProbed();
});

test('every declared file is checked for content, size, mode and regular-file type before probe', linux, async t => {
  for (const mutation of ['content', 'size', 'mode', 'directory']) await t.test(mutation, async t => {
    const f = await fixture(t), file = join(f.root, 'lib/libfreerdp-fixture.so');
    if (mutation === 'mode') await chmod(file, 0o600);
    else if (mutation === 'directory') { await rm(file); await mkdir(file); }
    else {
      const bytes = await readFile(file);
      await writeFile(file, mutation === 'content' ? Buffer.alloc(bytes.length, 0x78) : Buffer.concat([bytes, Buffer.from('extra')]));
    }
    unavailable(await f.readNativeRdpCapabilities(), 'DESKTOP_RDP_NATIVE_HASH_MISMATCH'); await f.assertNotProbed();
  });
});

test('executable entry must retain an executable mode even when manifest and file agree', linux, async t => {
  const f = await fixture(t); await chmod(f.executable, 0o644); f.manifest.files[0].mode = 0o644; await f.save();
  unavailable(await f.readNativeRdpCapabilities(), 'DESKTOP_RDP_NATIVE_MANIFEST'); await f.assertNotProbed();
});

test('leaf symlink cannot replace a declared runtime file or manifest', linux, async t => {
  for (const path of ['bin/xfreerdp3', 'lib/libfreerdp-fixture.so', 'manifest.json']) await t.test(path, async t => {
    const f = await fixture(t), original = join(f.root, path), external = join(f.folder, 'outside-file');
    await copyFile(original, external); await rm(original); await symlink(external, original);
    assert.equal((await f.readNativeRdpCapabilities()).available, false); await f.assertNotProbed();
  });
});

test('runtime parent-directory symlink cannot redirect verified files outside the private tree', linux, async t => {
  for (const directory of ['bin', 'lib']) await t.test(directory, async t => {
    const f = await fixture(t), original = join(f.root, directory), external = join(f.folder, 'outside-directory');
    // Bytes, sizes and modes remain identical. Leaf O_NOFOLLOW alone cannot catch this.
    await rename(original, external); await symlink(external, original, 'dir');
    assert.equal((await f.readNativeRdpCapabilities()).available, false); await f.assertNotProbed();
  });
});

test('runtime rejects files absent from the manifest, including possible private library shadows', linux, async t => {
  for (const path of ['unexpected-file', 'lib/libunexpected.so', 'extra/nested/file']) await t.test(path, async t => {
    const f = await fixture(t), extra = join(f.root, path);
    await mkdir(dirname(extra), { recursive: true }); await writeFile(extra, 'unlisted\n');
    assert.equal((await f.readNativeRdpCapabilities()).available, false); await f.assertNotProbed();
  });
});

test('probe protocol mismatch, malformed output, extra fields and nonzero exit never become available', linux, async t => {
  for (const [name, config, reason] of [
    ['patch mismatch', { probeOutput: JSON.stringify({ ...native, patchDigest: 'd'.repeat(64) }) }, 'DESKTOP_RDP_NATIVE_CAPABILITY_MISMATCH'],
    ['protocol mismatch', { probeOutput: JSON.stringify({ ...native, protocol: 'stock' }) }, 'DESKTOP_RDP_NATIVE_CAPABILITY_MISMATCH'],
    ['extra fields', { probeOutput: JSON.stringify({ ...native, unexpected: true }) }, 'DESKTOP_RDP_NATIVE_CAPABILITY_MISMATCH'],
    ['malformed JSON', { probeOutput: 'not-json' }, 'DESKTOP_RDP_NATIVE_PROBE_FAILED'],
    ['nonzero exit', { probeExit: 7 }, 'DESKTOP_RDP_NATIVE_PROBE_FAILED'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, config); unavailable(await f.readNativeRdpCapabilities(), reason);
    assert.equal(await readFile(f.marker, 'utf8'), 'called');
    assert.equal(await exists(await readFile(f.homeMarker, 'utf8')), false, 'probe HOME is removed on failure');
  });
});
