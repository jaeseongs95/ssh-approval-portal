import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../scripts/install-client.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); };
const json = value => JSON.stringify(value, null, 2) + '\n';
const parseJSON = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'client-install-'));
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'client-install-')));
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, 'source'), home = join(root, 'home'), programs = join(root, 'programs 한글');
  mkdirSync(home, { recursive: true });
  const files = new Map([
    ['scripts/portal-files.mjs', Buffer.from('console.log(JSON.stringify(process.argv.slice(2)));\n')],
    ['scripts/portal-completion-hook.mjs', Buffer.from('console.log("fixture hook");\n')],
    ...['codex', 'claude-code', 'antigravity'].map(host => [`hooks/${host}.json`, readFileSync(join(repository, 'hooks', `${host}.json`))]),
  ]);
  for (const [name, data] of files) save(join(source, name), data);
  let manifest, pin;
  function updateManifest(change = value => value) {
    manifest = change({ name: 'ssh-approval-portal-client', schemaVersion: '1.0.0', version: '2.3.0', files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: sha(data) })) });
    const data = json(manifest);
    save(join(source, 'client-manifest.json'), data);
    pin = sha(data);
  }
  updateManifest();
  function run(args = [], { env = {} } = {}) {
    return spawnSync(process.execPath, [installer, '--source', source, '--manifest-sha256', pin, '--install-root', programs, '--home', home, ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ...env },
    });
  }
  return { root, source, home, programs, target: join(programs, '2.3.0'), files, updateManifest, run,
    codex: join(home, '.codex', 'hooks.json'), antigravity: join(home, '.gemini', 'config', 'hooks.json') };
}

function ok(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout); }
function error(result, code) { assert.equal(result.status, 1, result.stdout); const body = JSON.parse(result.stderr); assert.equal(body.error.code, code, result.stderr); return body; }

test('I01 default plan is read-only and describes the version-specific target', t => {
  const f = fixture(t), result = ok(f.run());
  assert.equal(result.mode, 'plan');
  assert.equal(result.target, f.target);
  assert.equal(result.claude, null);
  assert.deepEqual(result.configChanges, []);
  assert.equal(existsSync(f.programs), false);
  assert.deepEqual(readdirSync(f.home), []);
});

test('I02 rejects an incorrect trusted manifest pin before writing', t => {
  const f = fixture(t);
  const manifest = join(f.source, 'client-manifest.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\n');
  error(f.run(['--apply']), 'MANIFEST_HASH_MISMATCH');
  assert.equal(existsSync(f.programs), false);
});

test('I03 rejects corrupted payload size and digest before writing', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'scripts/portal-files.mjs'), 'corrupt');
  error(f.run(['--apply']), 'FILE_INTEGRITY_MISMATCH');
  assert.equal(existsSync(f.programs), false);
});

for (const path of ['../escape', '/absolute', 'C:/drive', 'scripts\\bad', 'CON.txt', 'a./file', 'a /file', 'a//file', 'a:stream']) {
  test(`I04 rejects unsafe manifest path ${path}`, t => {
    const f = fixture(t);
    f.updateManifest(value => ({ ...value, files: [{ path, size: 0, sha256: sha('') }, ...value.files] }));
    error(f.run(['--apply']), 'UNSAFE_MANIFEST_PATH');
    assert.equal(existsSync(f.programs), false);
  });
}

test('I04 rejects case-insensitive duplicate paths', t => {
  const f = fixture(t);
  f.updateManifest(value => ({ ...value, files: [...value.files, { ...value.files[0], path: value.files[0].path.toUpperCase() }] }));
  error(f.run(['--apply']), 'INVALID_MANIFEST');
  assert.equal(existsSync(f.programs), false);
});

test('I05 installs a fresh version alongside an untouched previous version', t => {
  const f = fixture(t), previous = join(f.programs, '2.2.1', 'keep.txt');
  save(previous, 'previous-version-sentinel');
  const result = ok(f.run(['--apply']));
  assert.equal(result.installed, true);
  assert.equal(result.verification.liveHostHooks, 'not-verified');
  assert.equal(readFileSync(previous, 'utf8'), 'previous-version-sentinel');
  for (const [path, bytes] of f.files) assert.deepEqual(readFileSync(join(f.target, path)), bytes);
  if (process.platform === 'win32') {
    assert.deepEqual(readFileSync(join(f.target, 'portal-files.ps1')).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    assert.ok([...readFileSync(join(f.target, 'portal-files.cmd'))].every(byte => byte < 128));
  }
  assert.equal(existsSync(join(f.programs, '.install-client.lock')), false);
});

test('I06 preserves unrelated handlers, disabled Native hooks, BOM/CRLF, and exact backups', t => {
  const f = fixture(t);
  const other = { type: 'command', command: 'another-client --unchanged', timeout: 7 };
  const old = { type: 'command', command: 'node "/old/2.2.1/scripts/portal-completion-hook.mjs" --host codex' };
  const codexBefore = Buffer.from('\uFEFF' + json({ description: 'keep-description', hooks: { SessionStart: [{ matcher: '*', hooks: [other, old] }] }, other: [1, 2] }).replaceAll('\n', '\r\n'));
  const nativeBefore = Buffer.from(json({ unrelated: { enabled: true, Stop: [{ command: 'unchanged' }] }, 'ssh-completion-inbox': { enabled: false, Stop: [{ command: 'node /old/scripts/portal-completion-hook.mjs --host antigravity' }] } }));
  save(f.codex, codexBefore); save(f.antigravity, nativeBefore);
  const result = ok(f.run(['--hosts', 'codex,antigravity', '--apply']));
  const codex = parseJSON(f.codex), native = parseJSON(f.antigravity);
  assert.equal(codex.description, 'keep-description');
  assert.deepEqual(codex.other, [1, 2]);
  assert.deepEqual(codex.hooks.SessionStart[0], { matcher: '*', hooks: [other] });
  assert.equal(codex.hooks.SessionStart.flatMap(group => group.hooks).filter(handler => handler.command.includes('portal-completion-hook.mjs')).length, 1);
  assert.ok(codex.hooks.SessionStart.at(-1).hooks[0].command.includes(f.target));
  assert.deepEqual(native.unrelated, { enabled: true, Stop: [{ command: 'unchanged' }] });
  assert.equal(native['ssh-completion-inbox'].enabled, false);
  assert.ok(native['ssh-completion-inbox'].Stop[0].command.includes(f.target));
  const after = readFileSync(f.codex);
  assert.deepEqual(after.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(after.toString('utf8').replaceAll('\r\n', '').includes('\n'), false);
  assert.deepEqual(readFileSync(join(result.progress.backup, 'codex.before')), codexBefore);
  assert.deepEqual(readFileSync(join(result.progress.backup, 'antigravity.before')), nativeBefore);
});

test('I07 repeated application is idempotent and does not add backup directories', t => {
  const f = fixture(t);
  const first = ok(f.run(['--hosts', 'codex,antigravity', '--apply']));
  const codex = readFileSync(f.codex), native = readFileSync(f.antigravity);
  const backups = readdirSync(join(f.programs, 'backups'));
  const second = ok(f.run(['--hosts', 'codex,antigravity', '--apply']));
  assert.equal(first.reuse, false); assert.equal(second.reuse, true);
  assert.deepEqual(readFileSync(f.codex), codex); assert.deepEqual(readFileSync(f.antigravity), native);
  assert.deepEqual(second.progress.configured, []);
  assert.equal(second.progress.backup, null);
  assert.deepEqual(readdirSync(join(f.programs, 'backups')), backups);
});

test('I08 preserves a changed same-version installation and refuses overwrite', t => {
  const f = fixture(t);
  ok(f.run(['--apply']));
  const path = join(f.target, 'scripts', 'portal-files.mjs');
  writeFileSync(path, 'user change');
  error(f.run(['--apply']), 'TARGET_CONFLICT');
  assert.equal(readFileSync(path, 'utf8'), 'user change');
});

for (const body of ['{ invalid', '[]', '{"hooks":[]}']) {
  test(`I09 preserves invalid Codex config ${body}`, t => {
    const f = fixture(t); save(f.codex, body);
    error(f.run(['--hosts', 'codex', '--apply']), 'HOST_CONFIG_INVALID');
    assert.equal(readFileSync(f.codex, 'utf8'), body);
    assert.equal(existsSync(f.programs), false);
  });
}

test('I09 preserves an Antigravity hook-name conflict', t => {
  const f = fixture(t), body = json({ 'ssh-completion-inbox': { Stop: [{ command: 'another-client' }] } });
  save(f.antigravity, body);
  error(f.run(['--hosts', 'antigravity', '--apply']), 'HOST_HOOK_CONFLICT');
  assert.equal(readFileSync(f.antigravity, 'utf8'), body);
  assert.equal(existsSync(f.programs), false);
});

test('I10 rejects target parent symlink or Windows junction without touching its destination', t => {
  const f = fixture(t), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, f.programs, process.platform === 'win32' ? 'junction' : 'dir');
  error(f.run(['--apply']), 'UNSAFE_PATH');
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('I10 rejects a host config parent link', t => {
  const f = fixture(t), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(f.home, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  error(f.run(['--hosts', 'codex', '--apply']), 'UNSAFE_PATH');
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(existsSync(f.programs), false);
});

test('I11 generates TEST and PROD launchers with exact origin and executable arguments', t => {
  const f = fixture(t);
  const testOrigin = 'https://test.example.test', prodOrigin = 'https://prod.example.test';
  ok(f.run(['--apply', '--cloudflared', process.execPath, '--test-origin', testOrigin, '--prod-origin', prodOrigin]));
  for (const [mode, origin] of [['test', testOrigin], ['prod', prodOrigin]]) {
    const windows = process.platform === 'win32';
    const path = join(f.target, `portal-files-${mode}.${windows ? 'ps1' : 'sh'}`);
    const result = windows
      ? spawnSync('powershell.exe', ['-NoProfile', '-File', path, 'doctor', '한글 space'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      : spawnSync('/bin/sh', [path, 'doctor', '한글 space'], { encoding: 'utf8', timeout: 10_000 });
    const args = ok(result);
    assert.deepEqual(args.slice(0, 3), ['--origin', origin, '--cloudflared']);
    assert.ok(isAbsolutePath(args[3]));
    assert.deepEqual(args.slice(4), ['doctor', '한글 space']);
  }
});
const isAbsolutePath = path => process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/');

for (const origin of ['http://example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?q=x', 'https://example.test/#fragment']) {
  test(`I11 rejects unsafe launcher origin ${origin.replace('password', 'REDACTED')}`, t => {
    const f = fixture(t);
    error(f.run(['--apply', '--cloudflared', process.execPath, '--test-origin', origin]), 'INVALID_ORIGIN');
    assert.equal(existsSync(f.programs), false);
  });
}

test('I12 refuses an existing installation lock and preserves it', t => {
  const f = fixture(t), lock = join(f.programs, '.install-client.lock');
  save(lock, '{"pid":123,"owner":"sentinel"}');
  error(f.run(['--apply']), 'INSTALL_BUSY');
  assert.equal(readFileSync(lock, 'utf8'), '{"pid":123,"owner":"sentinel"}');
  assert.equal(existsSync(f.target), false);
});

test('I13 Claude plan uses official registration and absolute hook arguments without running Claude', t => {
  const f = fixture(t);
  // Deliberately unreadable-as-files: plan must not inspect raw Claude settings/registries.
  for (const path of ['settings.json', 'plugins/known_marketplaces.json', 'plugins/installed_plugins.json']) mkdirSync(join(f.home, '.claude', path), { recursive: true });
  const result = ok(f.run(['--hosts', 'claude-code', '--claude', process.execPath]));
  assert.deepEqual(result.claude.args, ['plugin', 'install', 'ssh-completion-client', '--marketplace', join(f.target, '.claude-marketplace'), '--scope', 'user', '--json']);
  assert.equal(result.reload.automatic, false);
  assert.equal('claudeBackupFiles' in result, false);
  assert.match(result.claudeRecovery, /raw Claude settings.*never read/);
  assert.equal(existsSync(f.programs), false);
  assert.equal(result.files.some(file => file.path === '.claude-marketplace/plugins/ssh-completion-client/hooks/claude-code.json'), true);
});

test('reviewed plan pin detects a changed source setting before any installation', t => {
  const f = fixture(t), plan = ok(f.run(['--hosts', 'codex']));
  save(f.codex, json({ description: 'changed after review' }));
  error(f.run(['--hosts', 'codex', '--apply', '--expect-plan', plan.planSha256]), 'PLAN_CHANGED');
  assert.equal(existsSync(f.programs), false);
});

test('reviewed plan pin accepts the same inputs for apply', t => {
  const f = fixture(t), plan = ok(f.run(['--hosts', 'codex']));
  const result = ok(f.run(['--hosts', 'codex', '--apply', '--expect-plan', plan.planSha256]));
  assert.equal(result.planSha256, plan.planSha256);
});

test('host names are explicit and Gemini CLI is not accepted as Native Antigravity', t => {
  const f = fixture(t);
  error(f.run(['--hosts', 'gemini', '--apply']), 'INVALID_HOST');
  assert.equal(existsSync(f.programs), false);
});
