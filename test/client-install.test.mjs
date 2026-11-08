import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
    ['LICENSE', Buffer.from('Fixture license\n')],
    ['scripts/portal-files.mjs', Buffer.from('console.log(JSON.stringify(process.argv.slice(2)));\n')],
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
  assert.equal(codex.hooks.SessionStart.flatMap(group => group.hooks).filter(handler => handler.command.includes('portal-files.mjs')).length, 1);
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

test('I13 Claude plan pins official read-only metadata and planned qualified commands without host mutation', t => {
  const f = claudeFixture(t, { fresh: true });
  // Deliberately unreadable-as-files: plan must not inspect raw Claude settings/registries.
  for (const path of ['settings.json', 'plugins/known_marketplaces.json', 'plugins/installed_plugins.json']) mkdirSync(join(f.home, '.claude', path), { recursive: true });
  const result = ok(f.runClaude({ plan: true }));
  assert.deepEqual(result.claude.sourceArgs, ['plugin', 'marketplace', 'add', join(f.target, '.claude-marketplace'), '--scope', 'user', '--json']);
  assert.deepEqual(result.claude.installArgs, ['plugin', 'install', 'ssh-completion-client@ssh-mcp-client-local', '--scope', 'user', '--json']);
  assert.deepEqual(result.claude.updateArgs, ['plugin', 'update', 'ssh-completion-client@ssh-mcp-client-local', '--scope', 'user', '--json']);
  assert.equal(result.reload.automatic, false);
  assert.equal('claudeBackupFiles' in result, false);
  assert.match(result.claudeRecovery, /raw Claude settings.*never read/);
  assert.equal(existsSync(f.target), false);
  assert.equal(result.files.some(file => file.path === '.claude-marketplace/plugins/ssh-completion-client/hooks/claude-code.json'), true);
  assert.deepEqual(f.state().calls, [['list', '--json'], ['marketplace', 'list', '--json']]);
  assert.equal(result.claudeBefore.metadata, null);
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

function claudeFixture(t, { fresh = false, enabled = true, ...overrides } = {}) {
  const f = fixture(t), id = 'ssh-completion-client@ssh-mcp-client-local';
  const source = join(f.programs, '2.2.1', '.claude-marketplace');
  save(join(source, '.claude-plugin', 'marketplace.json'), json({ name: 'ssh-mcp-client-local', plugins: [{ name: 'ssh-completion-client', source: './plugins/ssh-completion-client' }] }));
  save(join(source, 'plugins', 'ssh-completion-client', '.claude-plugin', 'plugin.json'), json({ name: 'ssh-completion-client', version: '2.2.1' }));
  const unrelated = { id: 'unrelated@another-marketplace', version: '7.0.0', scope: 'project', enabled: false, readFromFolder: null, folderVersion: null };
  const own = { id, version: '2.2.1', scope: 'user', enabled, readFromFolder: join(source, 'plugins', 'ssh-completion-client'), folderVersion: '2.2.1' };
  const statePath = join(f.root, 'claude-fixture-state.json');
  save(statePath, json({ plugins: fresh ? [unrelated] : [unrelated, own], marketplaces: fresh ? [] : [{ name: 'ssh-mcp-client-local', source: 'directory', path: source, installLocation: source }], calls: [], ...overrides }));
  const shim = join(f.root, 'claude-fixture-preload.mjs');
  save(shim, `import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
if (basename(process.argv[1] ?? '') === 'plugin') {
  const path = process.env.SSH_INSTALL_TEST_STATE;
  const state = JSON.parse(readFileSync(path, 'utf8'));
  const args = process.argv.slice(2), id = 'ssh-completion-client@ssh-mcp-client-local';
  state.calls.push(args);
  function output(body, code = 0) { writeFileSync(path, JSON.stringify(state)); process.stdout.write(JSON.stringify(body) + '\\n'); process.exit(code); }
  if (args[0] === 'list') {
    state.listCalls = (state.listCalls ?? 0) + 1;
    if (state.changeAtList === state.listCalls) state.plugins.find(item => item.id === id).enabled = false;
    output(state.plugins);
  }
  if (args[0] === 'marketplace' && args[1] === 'list') output(state.marketplaces);
  const stage = args[0] === 'marketplace' ? 'add' : args[0];
  if (state.failStage === stage) output({ command: stage, outcome: 'failed', failureCode: state.failCode ?? 'name_taken', message: 'secret-fixture-value' }, 1);
  if (stage === 'add') {
    const source = args[2];
    state.marketplaces = [{ name: 'ssh-mcp-client-local', source: 'directory', path: source, installLocation: source }];
    const manifest = JSON.parse(readFileSync(join(source, 'plugins', 'ssh-completion-client', '.claude-plugin', 'plugin.json'), 'utf8'));
    for (const plugin of state.plugins) if (plugin.id === id) { plugin.readFromFolder = join(source, 'plugins', 'ssh-completion-client'); plugin.folderVersion = manifest.version; }
    output({ command: 'marketplace-add', outcome: 'ok' });
  }
  if (stage === 'update' || stage === 'install') {
    const source = state.marketplaces.find(item => item.name === 'ssh-mcp-client-local').path;
    const manifest = JSON.parse(readFileSync(join(source, 'plugins', 'ssh-completion-client', '.claude-plugin', 'plugin.json'), 'utf8'));
    const previous = state.plugins.find(item => item.id === id && item.scope === 'user');
    if (!state.skipUpdate) {
      state.plugins = state.plugins.filter(item => !(item.id === id && item.scope === 'user'));
      state.plugins.push({ id, version: manifest.version, scope: 'user', enabled: previous?.enabled ?? true, readFromFolder: join(source, 'plugins', 'ssh-completion-client'), folderVersion: manifest.version });
    }
    if (state.mutateOther) state.plugins[0].enabled = !state.plugins[0].enabled;
    output({ command: stage, outcome: 'ok' });
  }
  output({ failureCode: 'unsupported_fixture_command' }, 1);
}
`);
  const run = ({ plan = false, args = [] } = {}) => f.run(['--hosts', 'claude-code', '--claude', process.execPath, ...(plan ? [] : ['--apply']), ...args], { env: { NODE_OPTIONS: '--import=' + pathToFileURL(shim).href, SSH_INSTALL_TEST_STATE: statePath } });
  return { ...f, source, statePath, unrelated, own, runClaude: run, state: () => parseJSON(statePath) };
}

test('U01 source add then qualified user update verifies new version and preserves unrelated project plugin', t => {
  const f = claudeFixture(t);
  const result = ok(f.runClaude()), state = f.state();
  assert.deepEqual(state.calls, [['list', '--json'], ['marketplace', 'list', '--json'], ['list', '--json'], ['marketplace', 'list', '--json'], ['marketplace', 'add', join(f.target, '.claude-marketplace'), '--scope', 'user', '--json'], ['update', 'ssh-completion-client@ssh-mcp-client-local', '--scope', 'user', '--json'], ['list', '--json'], ['marketplace', 'list', '--json']]);
  assert.deepEqual(state.plugins.find(plugin => plugin.id === f.unrelated.id), f.unrelated);
  assert.equal(result.progress.claude, 'verified');
  assert.deepEqual(result.progress.claudeSteps, ['inventory-verified', 'marketplace-added', 'plugin-updated', 'post-inventory-verified']);
  const backup = parseJSON(join(result.progress.backup, 'claude-plugin.before.json'));
  assert.equal(backup.registration.version, '2.2.1');
  assert.equal(backup.marketplace.path, f.source);
  assert.equal(readFileSync(join(f.target, '.claude-marketplace/plugins/ssh-completion-client/LICENSE'), 'utf8'), 'Fixture license\n');
});

test('U02 exact registration is reused without a host mutation or another backup', t => {
  const f = claudeFixture(t);
  ok(f.runClaude());
  const backups = readdirSync(join(f.programs, 'backups'));
  const before = f.state().calls.length;
  const result = ok(f.runClaude());
  assert.equal(result.progress.claude, 'already-registered');
  assert.equal(result.progress.backup, null);
  assert.deepEqual(f.state().calls.slice(before), [['list', '--json'], ['marketplace', 'list', '--json'], ['list', '--json'], ['marketplace', 'list', '--json'], ['list', '--json'], ['marketplace', 'list', '--json']]);
  assert.deepEqual(readdirSync(join(f.programs, 'backups')), backups);
});

test('U03 disabled user selection survives source upgrade and official update', t => {
  const f = claudeFixture(t, { enabled: false });
  ok(f.runClaude());
  assert.equal(f.state().plugins.find(plugin => plugin.id === f.own.id).enabled, false);
  assert.equal(f.state().plugins.find(plugin => plugin.id === f.own.id).version, '2.3.0');
});

test('U07 fresh registration adds source before qualified user install', t => {
  const f = claudeFixture(t, { fresh: true });
  const result = ok(f.runClaude());
  assert.deepEqual(f.state().calls[5], ['install', 'ssh-completion-client@ssh-mcp-client-local', '--scope', 'user', '--json']);
  assert.deepEqual(result.progress.claudeSteps, ['inventory-verified', 'marketplace-added', 'plugin-installed', 'post-inventory-verified']);
  assert.equal(f.state().plugins.find(plugin => plugin.id === f.own.id).enabled, true);
});

test('U04 existing foreign source is never retargeted even when it has no installed plugin', t => {
  const f = claudeFixture(t, { fresh: true, marketplaces: [{ name: 'ssh-mcp-client-local', source: 'directory', path: join(tmpdir(), 'foreign-catalog') }] });
  error(f.runClaude(), 'CLAUDE_MARKETPLACE_CONFLICT');
  assert.deepEqual(f.state().calls, [['list', '--json'], ['marketplace', 'list', '--json']]);
  assert.equal(existsSync(f.target), false);
});

for (const scope of ['project', 'local', 'managed']) {
  test(`U04 refuses a source change shared with ${scope} scope`, t => {
    const f = claudeFixture(t), state = f.state();
    state.plugins.push({ ...f.own, scope }); save(f.statePath, json(state));
    error(f.runClaude(), 'CLAUDE_SCOPE_CONFLICT');
    assert.equal(f.state().calls.length, 2);
    assert.equal(existsSync(f.target), false);
  });
}

test('U08 dedicated catalog guard rejects another plugin before source mutation', t => {
  const f = claudeFixture(t), path = join(f.source, '.claude-plugin/marketplace.json');
  const body = parseJSON(path); body.plugins.push({ name: 'other-plugin', source: './plugins/other-plugin' }); save(path, json(body));
  error(f.runClaude(), 'CLAUDE_MARKETPLACE_CONFLICT');
  assert.equal(f.state().calls.length, 2);
  assert.equal(existsSync(f.target), false);
});

for (const failStage of ['add', 'update']) {
  test(`U06 ${failStage} failure preserves a safe hostCode and exact partial stage without host output`, t => {
    const f = claudeFixture(t, { failStage, failCode: 'name_taken' });
    const result = f.runClaude(), body = error(result, 'HOST_COMMAND_FAILED');
    assert.equal(body.error.hostCode, 'name_taken');
    assert.equal(body.partialApply.claude, failStage === 'add' ? 'marketplace-add-started' : 'plugin-update-started');
    assert.equal(body.partialApply.claudeSteps.includes('marketplace-added'), failStage === 'update');
    assert.equal((result.stdout + result.stderr).includes('secret-fixture-value'), false);
  });
}

for (const failCode of ['bad\nsecret-fixture-value', 'SecretFixtureValue']) {
  test('U06 non-allowlisted host code is suppressed rather than exposing host output', t => {
    const f = claudeFixture(t, { failStage: 'add', failCode });
    const result = f.runClaude(), body = error(result, 'HOST_COMMAND_FAILED');
    assert.equal('hostCode' in body.error, false);
    assert.equal(result.stderr.includes('secret-fixture-value'), false);
    assert.equal(result.stderr.includes('SecretFixtureValue'), false);
  });
}

for (const state of [{ skipUpdate: true }, { mutateOther: true }]) {
  test(`U06 official exit zero is not success if final inventory differs: ${Object.keys(state)[0]}`, t => {
    const f = claudeFixture(t, state);
    const body = error(f.runClaude(), 'CLAUDE_POST_INSTALL_MISMATCH');
    assert.equal(body.partialApply.claude, 'post-inventory-started');
    assert.equal(body.partialApply.claudeSteps.includes('plugin-updated'), true);
  });
}

for (const change of ['own-enabled', 'unrelated-enabled']) {
  test(`reviewed Claude plan rejects ${change} metadata changes before target or source mutation`, t => {
    const f = claudeFixture(t), plan = ok(f.runClaude({ plan: true }));
    const state = f.state();
    state.plugins.find(item => item.id === (change === 'own-enabled' ? f.own.id : f.unrelated.id)).enabled = true;
    if (change === 'own-enabled') state.plugins.find(item => item.id === f.own.id).enabled = false;
    save(f.statePath, json(state));
    error(f.runClaude({ args: ['--expect-plan', plan.planSha256] }), 'PLAN_CHANGED');
    assert.equal(existsSync(f.target), false);
    assert.deepEqual(f.state().calls, [['list', '--json'], ['marketplace', 'list', '--json'], ['list', '--json'], ['marketplace', 'list', '--json']]);
  });
}

test('Claude metadata changed at the apply lock boundary stops before copying or source mutation', t => {
  const f = claudeFixture(t, { changeAtList: 2 });
  error(f.runClaude(), 'CLAUDE_SOURCE_CHANGED');
  assert.equal(existsSync(f.target), false);
  assert.equal(f.state().calls.some(args => args.includes('add') || args.includes('update') || args.includes('install')), false);
});

test('another installed plugin using the same marketplace identity blocks a source change', t => {
  const f = claudeFixture(t), state = f.state();
  state.plugins.push({ ...f.own, id: 'other-plugin@ssh-mcp-client-local' }); save(f.statePath, json(state));
  error(f.runClaude(), 'CLAUDE_SCOPE_CONFLICT');
  assert.equal(existsSync(f.target), false);
  assert.equal(f.state().calls.length, 2);
});

// AW17 cases were frozen before execution in ../auto-hook-20261106-r1/TEST-CASES.ko.md.
test('AW17 origin installation configures automatic watch routes and preserves unrelated native handlers', t => {
  const f = fixture(t), origin = 'https://owner.example.test';
  const other = { type: 'command', command: 'another-client --unchanged', timeout: 7 };
  const nativeOther = { enabled: true, Stop: [{ command: 'another-native-client --unchanged' }] };
  save(f.codex, json({ hooks: { PostToolUse: [{ matcher: '*', hooks: [other] }] } }));
  save(f.antigravity, json({ unrelated: nativeOther }));
  const tools = ['mcp__custom_submit', 'mcp__custom_observe'];
  ok(f.run(['--hosts', 'codex,antigravity', '--test-origin', origin, '--cloudflared', process.execPath,
    '--test-mcp-tools', tools.join(','), '--apply']));
  const watchPath = join(f.target, 'completion-watch.json');
  assert.deepEqual(parseJSON(watchPath), { version: 1, cloudflared: process.execPath, routes: [{ origin, tools }] });
  const codex = parseJSON(f.codex), native = parseJSON(f.antigravity);
  assert.deepEqual(codex.hooks.PostToolUse[0], { matcher: '*', hooks: [other] });
  for (const handler of Object.values(codex.hooks).flatMap(groups => groups.flatMap(group => group.hooks)).filter(handler => handler !== codex.hooks.PostToolUse[0].hooks[0])) {
    assert.ok(handler.command.includes('--watch-config')); assert.ok(handler.command.includes(watchPath));
  }
  assert.deepEqual(native.unrelated, nativeOther);
  for (const [event, handlers] of Object.entries(native['ssh-completion-inbox'])) {
    if (event === 'enabled') continue;
    for (const handler of handlers) { assert.ok(handler.command.includes('--watch-config')); assert.ok(handler.command.includes(watchPath)); }
  }
});

test('AW17 Claude package hooks receive the installed automatic watch config without changing another plugin', t => {
  const f = claudeFixture(t), origin = 'https://owner.example.test', tools = ['custom_submit', 'custom_observe'];
  ok(f.runClaude({ args: ['--test-origin', origin, '--cloudflared', process.execPath, '--test-mcp-tools', tools.join(',')] }));
  const watchPath = join(f.target, 'completion-watch.json');
  assert.deepEqual(parseJSON(watchPath), { version: 1, cloudflared: process.execPath, routes: [{ origin, tools }] });
  const manifest = parseJSON(join(f.target, '.claude-marketplace/plugins/ssh-completion-client/hooks/claude-code.json'));
  for (const handler of Object.values(manifest.hooks).flatMap(groups => groups.flatMap(group => group.hooks))) {
    assert.equal(handler.args[handler.args.indexOf('--watch-config') + 1], watchPath);
  }
  assert.deepEqual(f.state().plugins.find(plugin => plugin.id === f.unrelated.id), f.unrelated);
});

test('AW17 malformed explicit MCP route aliases stop before installation or host configuration changes', t => {
  const f = fixture(t);
  error(f.run(['--hosts', 'codex,antigravity', '--test-origin', 'https://owner.example.test',
    '--cloudflared', process.execPath, '--test-mcp-tools', 'valid_submit,invalid\nroute', '--apply']), 'INVALID_ARGUMENT');
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(f.codex), false); assert.equal(existsSync(f.antigravity), false);
});

test('I14 --manifest-sha256 auto computes pin from source manifest and discovers cloudflared from PORTAL_CLOUDFLARED', t => {
  const f = fixture(t);
  const result = ok(spawnSync(process.execPath, [installer, '--source', f.source, '--manifest-sha256', 'auto', '--install-root', f.programs, '--home', f.home, '--test-origin', 'https://test.example.test', '--apply'], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, LOCALAPPDATA: join(f.home, 'AppData', 'Local'), PORTAL_CLOUDFLARED: process.execPath },
  }));
  assert.equal(result.installed, true);
  const watchPath = join(f.target, 'completion-watch.json');
  assert.equal(parseJSON(watchPath).cloudflared, process.execPath);
  assert.equal(existsSync(join(f.target, 'scripts', 'portal-completion-hook.mjs')), false);
});
