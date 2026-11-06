#!/usr/bin/env node
// Standalone installer: only Node built-ins; authentication and PATH are untouched.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { resolve, dirname, join, isAbsolute, parse, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, detail) => { throw Object.assign(new Error(detail), { code }); };
const exists = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

function safePath(path) {
  let current = resolve(path);
  for (;;) {
    const stat = exists(current);
    // On Windows Node reports junctions/reparse-point links as symbolic links.
    if (stat?.isSymbolicLink()) fail('UNSAFE_PATH', `Linked path is not supported: ${current}`);
    if (current === dirname(current)) break;
    current = dirname(current);
  }
}

function readOptional(path) {
  safePath(path);
  const stat = exists(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('UNSAFE_PATH', `Expected a regular file of at most 8 MiB: ${path}`);
  return readFileSync(path);
}

function manifestPath(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\:\x00-\x1f<>"|?*]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('UNSAFE_MANIFEST_PATH', 'Manifest contains an unsafe portable file path');
  }
  return name;
}

function bundle(source, pin) {
  const manifestBytes = readOptional(join(source, 'client-manifest.json'));
  if (!manifestBytes) fail('MANIFEST_MISSING', 'Use an extracted standalone client release, not the server source tree');
  if (hash(manifestBytes) !== pin) fail('MANIFEST_HASH_MISMATCH', 'Manifest does not match --manifest-sha256');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('INVALID_MANIFEST', 'Manifest is not JSON'); }
  if (manifest?.name !== 'ssh-approval-portal-client' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 512) {
    fail('INVALID_MANIFEST', 'Unexpected client manifest name, version, or file count');
  }
  const files = new Map(), seen = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    const name = manifestPath(entry?.path), key = name.toLowerCase();
    if (key === 'client-manifest.json' || seen.has(key) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || entry.size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail('INVALID_MANIFEST', 'Invalid or duplicate manifest entry');
    seen.add(key);
    total += entry.size;
    if (total > 64 * 1024 * 1024) fail('INVALID_MANIFEST', 'Client bundle exceeds 64 MiB');
    const data = readOptional(join(source, ...name.split('/')));
    if (!data || data.length !== entry.size || hash(data) !== entry.sha256) fail('FILE_INTEGRITY_MISMATCH', `Released file mismatch: ${name}`);
    files.set(name, data);
  }
  for (const name of seen) for (let parent = name; parent.includes('/');) {
    parent = parent.slice(0, parent.lastIndexOf('/'));
    if (seen.has(parent)) fail('INVALID_MANIFEST', 'Manifest file/directory paths overlap');
  }
  for (const name of ['scripts/portal-files.mjs', 'scripts/portal-completion-hook.mjs', 'hooks/codex.json', 'hooks/claude-code.json', 'hooks/antigravity.json']) {
    if (!files.has(name)) fail('INVALID_MANIFEST', `Required client file missing: ${name}`);
  }
  files.set('client-manifest.json', manifestBytes);
  return { manifest, files };
}

function executable(path, label) {
  if (!isAbsolute(path) || /[\x00\r\n]/.test(path)) fail('EXECUTABLE_INVALID', `${label} must be an existing absolute executable path`);
  const actual = realpathSync(path);
  if (!lstatSync(actual).isFile()) fail('EXECUTABLE_INVALID', `${label} is not a regular executable`);
  return actual;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Do not echo third-party stdout/stderr: host output can contain private settings.
  if (result.error || result.status !== 0) fail('HOST_COMMAND_FAILED', `${label} failed (${result.error?.code ?? `exit ${result.status}`}); inspect the host CLI directly`);
  return result.stdout;
}

function claudeRegistration(claude, version, target) {
  let result;
  try { result = JSON.parse(run(claude.command, ['plugin', 'list', '--json'], 'Claude plugin inventory')); }
  catch (error) { if (error.code) throw error; fail('CLAUDE_INVENTORY_INVALID', 'Claude plugin list did not return JSON; no registration was attempted'); }
  const plugins = Array.isArray(result) ? result : result?.plugins;
  if (!Array.isArray(plugins)) fail('CLAUDE_INVENTORY_INVALID', 'Claude plugin list has an unsupported JSON shape');
  const own = plugins.filter(plugin => plugin.id === 'ssh-completion-client@ssh-mcp-client-local' && plugin.scope === 'user');
  if (own.length > 1) fail('CLAUDE_INVENTORY_INVALID', 'Multiple user registrations exist for the SSH completion plugin');
  const plugin = own[0];
  const expected = join(target, '.claude-marketplace', 'plugins', 'ssh-completion-client');
  const same = plugin?.version === version && typeof plugin.readFromFolder === 'string' && resolve(plugin.readFromFolder) === resolve(expected);
  if (plugin?.enabled === false && !same) fail('CLAUDE_PLUGIN_DISABLED', 'Existing SSH plugin is disabled; preserve that choice and perform the desired upgrade through the host CLI');
  const metadata = plugin ? Object.fromEntries(['id', 'version', 'scope', 'enabled', 'readFromFolder'].map(key => [key, plugin[key] ?? null])) : null;
  return { state: same ? (plugin.enabled === false ? 'already-registered-disabled' : 'already-registered') : null, metadata };
}

function shellWord(value) {
  if (process.platform !== 'win32') return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/["%!^\r\n\x00]/.test(value)) fail('UNSUPPORTED_SHELL_PATH', 'Windows command paths cannot contain quotes, percent, exclamation, or caret');
  return '"' + value + '"';
}
const psWord = value => "'" + value.replaceAll("'", "''") + "'";
function hookCommand(node, script, host, event) {
  return [shellWord(node), shellWord(script), '--host', host, ...(event ? ['--event', event] : [])].join(' ');
}

function parsedConfig(before, label) {
  if (!before) return {};
  let value;
  try { value = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('HOST_CONFIG_INVALID', `${label} hook configuration is not JSON`); }
  if (!object(value)) fail('HOST_CONFIG_INVALID', `${label} hook configuration must be an object`);
  return value;
}
const sshHandler = handler => object(handler) && [handler.command, handler.commandWindows, ...(Array.isArray(handler.args) ? handler.args : [])].some(value => typeof value === 'string' && /(?:^|[\\/])portal-completion-hook\.mjs(?:["'\s]|$)/.test(value));

function configChange(host, path, files, node, target) {
  const before = readOptional(path), body = parsedConfig(before, host);
  const script = join(target, 'scripts', 'portal-completion-hook.mjs');
  if (host === 'codex') {
    if (body.hooks !== undefined && !object(body.hooks)) fail('HOST_CONFIG_INVALID', 'Codex hooks must be an object');
    body.hooks ??= {};
    const template = JSON.parse(files.get('hooks/codex.json').toString('utf8'));
    // Remove only this client's handlers, preserving other handlers in the same groups.
    for (const [event, groups] of Object.entries(body.hooks)) {
      if (!Array.isArray(groups)) fail('HOST_CONFIG_INVALID', `Codex ${event} must be an array`);
      body.hooks[event] = groups.flatMap(group => {
        if (!object(group) || !Array.isArray(group.hooks)) fail('HOST_CONFIG_INVALID', 'Codex hook group must contain hooks');
        const hooks = group.hooks.filter(handler => !sshHandler(handler));
        return hooks.length ? [{ ...group, hooks }] : [];
      });
    }
    for (const [event, groups] of Object.entries(template.hooks)) {
      const generated = structuredClone(groups);
      for (const group of generated) for (const handler of group.hooks) {
        handler.command = hookCommand(node, script, 'codex');
        handler.commandWindows = '& ' + psWord(node) + ' ' + psWord(script) + ' --host codex';
      }
      body.hooks[event] = [...(body.hooks[event] ?? []), ...generated];
    }
  } else {
    const key = 'ssh-completion-inbox';
    const previous = body[key];
    if (previous !== undefined) {
      if (!object(previous)) fail('HOST_HOOK_CONFLICT', 'Antigravity SSH hook name is occupied');
      for (const [event, handlers] of Object.entries(previous)) {
        if (event === 'enabled') continue;
        if (!Array.isArray(handlers) || !handlers.every(sshHandler)) fail('HOST_HOOK_CONFLICT', 'Antigravity SSH hook has unrecognized handlers; preserve it and resolve manually');
      }
    }
    const generated = JSON.parse(files.get('hooks/antigravity.json').toString('utf8'))[key];
    if (previous?.enabled === false) generated.enabled = false;
    for (const [event, handlers] of Object.entries(generated)) {
      if (event === 'enabled') continue;
      for (const handler of handlers) handler.command = hookCommand(node, script, 'antigravity', event);
    }
    body[key] = generated;
  }
  const original = before ? parsedConfig(before, host) : null;
  if (JSON.stringify(original) === JSON.stringify(body)) return { host, path, before, after: before, changed: false };
  const bom = before?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const newline = before?.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const after = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from((JSON.stringify(body, null, 2) + '\n').replaceAll('\n', newline))]);
  return { host, path, before, after, changed: true };
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ORIGIN', 'Launcher origin must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_ORIGIN', 'Launcher origin must be HTTPS with no credentials, path, query, or fragment');
  return url.origin;
}

function generatedFiles(files, options, version, target, node) {
  const add = (name, data) => {
    if (files.has(name)) fail('INVALID_MANIFEST', `Generated installer path conflicts with release: ${name}`);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Windows PowerShell 5.1 requires a BOM to decode non-ASCII paths as UTF-8.
    files.set(name, name.endsWith('.ps1') ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
  };
  const windows = process.platform === 'win32';
  if (windows) { shellWord(node); shellWord(target); }
  for (const [name, entry] of [['portal-files', 'portal-files.mjs'], ['portal-completion-hook', 'portal-completion-hook.mjs']]) {
    const script = join(target, 'scripts', entry);
    if (windows) {
      // ASCII-only CMD delegates Unicode path handling to the BOM-tagged PS1.
      add(`${name}.cmd`, `@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "%~dp0${name}.ps1" %*\r\nexit /b %errorlevel%\r\n`);
      add(`${name}.ps1`, `& ${psWord(node)} ${psWord(script)} @args\nexit $LASTEXITCODE\n`);
    } else add(`${name}.sh`, `#!/bin/sh\nexec ${shellWord(node)} ${shellWord(script)} "$@"\n`);
  }
  for (const mode of ['test', 'prod']) {
    const value = options[`${mode}-origin`];
    if (!value) continue;
    const url = origin(value);
    if (!options.cloudflared) fail('CLOUDFLARED_REQUIRED', '--cloudflared absolute path is required for origin launchers');
    const cloudflared = executable(options.cloudflared, 'cloudflared');
    const script = join(target, 'scripts', 'portal-files.mjs');
    if (windows) add(`portal-files-${mode}.ps1`, `& ${psWord(node)} ${psWord(script)} --origin ${psWord(url)} --cloudflared ${psWord(cloudflared)} @args\nexit $LASTEXITCODE\n`);
    else add(`portal-files-${mode}.sh`, `#!/bin/sh\nexec ${shellWord(node)} ${shellWord(script)} --origin ${shellWord(url)} --cloudflared ${shellWord(cloudflared)} "$@"\n`);
  }
  if (options.hosts.includes('claude-code')) {
    const prefix = '.claude-marketplace/plugins/ssh-completion-client/';
    const hooks = JSON.parse(files.get('hooks/claude-code.json').toString('utf8'));
    for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) {
      handler.command = node;
      handler.args = handler.args.map(arg => arg.replace('${CLAUDE_PLUGIN_ROOT}/scripts/portal-completion-hook.mjs', join(target, 'scripts', 'portal-completion-hook.mjs')));
    }
    add(prefix + '.claude-plugin/plugin.json', json({ name: 'ssh-completion-client', version, description: 'SSH MCP client native completion hooks', author: { name: 'SSH MCP client' }, hooks: './hooks/claude-code.json' }));
    add(prefix + 'hooks/claude-code.json', json(hooks));
    // Keep the established marketplace identity so an upgrade replaces this plugin only.
    add('.claude-marketplace/.claude-plugin/marketplace.json', json({ name: 'ssh-mcp-client-local', owner: { name: 'Local SSH MCP client' }, metadata: { description: 'Installed SSH MCP client native hooks' }, plugins: [{ name: 'ssh-completion-client', source: './plugins/ssh-completion-client', version }] }));
  }
}

function unchanged(change) {
  const current = readOptional(change.path);
  if ((current ? hash(current) : null) !== (change.before ? hash(change.before) : null)) fail('HOST_SOURCE_CHANGED', `Host configuration changed: ${change.host}`);
}

function writeNew(path, bytes, mode = 0o600) {
  safePath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function replaceConfig(change) {
  unchanged(change);
  const temp = change.path + '.ssh-client-' + randomUUID() + '.tmp';
  writeNew(temp, change.after, exists(change.path)?.mode & 0o777 || 0o600);
  try { unchanged(change); renameSync(temp, change.path); }
  finally { if (exists(temp)) unlinkSync(temp); }
}

function parseArgs(argv) {
  const options = {};
  const values = new Set(['source', 'manifest-sha256', 'install-root', 'home', 'node', 'cloudflared', 'test-origin', 'prod-origin', 'hosts', 'claude', 'expect-plan']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (['apply', 'help'].includes(key) && argv[i].startsWith('--') && !(key in options)) options[key] = true;
    else if (argv[i].startsWith('--') && values.has(key) && !(key in options) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else fail('INVALID_ARGUMENT', `Unknown, duplicate, or incomplete option: ${argv[i]}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/install-client.mjs --manifest-sha256 SHA256 [--source EXTRACTED] [--install-root DIR] [--home DIR] [--hosts codex,claude-code,antigravity|none] [--node ABSOLUTE] [--claude ABSOLUTE] [--cloudflared ABSOLUTE --test-origin HTTPS --prod-origin HTTPS] [--apply] [--expect-plan SHA256]\nDefault: read-only plan. Install root contains a separate directory for each version. See docs/client-install.ko.md.\n');
    return;
  }
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) fail('PLATFORM_UNSUPPORTED', 'Supported installer platforms: Windows, Linux, macOS');
  if (!/^[a-f0-9]{64}$/.test(options['manifest-sha256'] ?? '')) fail('MANIFEST_PIN_REQUIRED', 'Pass the trusted release manifest SHA-256 using --manifest-sha256');
  options.hosts = (options.hosts ?? 'none').split(',');
  if (options.hosts.length === 1 && options.hosts[0] === 'none') options.hosts = [];
  if (new Set(options.hosts).size !== options.hosts.length || options.hosts.some(host => !['codex', 'claude-code', 'antigravity'].includes(host))) fail('INVALID_HOST', 'Choose codex, claude-code, antigravity, or none; Gemini CLI is not Antigravity');
  const home = resolve(options.home ?? homedir());
  if (options.hosts.includes('claude-code') && home !== resolve(homedir())) fail('CLAUDE_HOME_UNSUPPORTED', 'Claude registration uses the actual user home; a custom --home supports only Codex/Antigravity fixture or custom configuration');
  const source = resolve(options.source ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const root = resolve(options['install-root'] ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'ssh-approval-portal-client') : join(home, '.local', 'share', 'ssh-approval-portal-client')));
  safePath(source); safePath(root); safePath(home);
  const { manifest, files } = bundle(source, options['manifest-sha256']);
  const target = join(root, manifest.version);
  if (source === target || relative(source, target) === '' || (!relative(source, target).startsWith('..') && !isAbsolute(relative(source, target)))) fail('TARGET_INSIDE_SOURCE', 'Install root must be outside the extracted source');
  const node = executable(options.node ?? process.execPath, 'Node');
  const nodeVersion = run(node, ['--version'], 'Node version check').trim();
  if (!/^v24\.(\d+)\.\d+$/.test(nodeVersion) || Number(nodeVersion.split('.')[1]) < 2) fail('NODE_VERSION_UNSUPPORTED', 'Preinstalled Node >=24.2.0 <25 is required');
  generatedFiles(files, options, manifest.version, target, node);
  const finalNames = new Set([...files.keys()].map(name => name.toLowerCase()));
  for (const name of finalNames) for (let parent = name; parent.includes('/');) {
    parent = parent.slice(0, parent.lastIndexOf('/'));
    if (finalNames.has(parent)) fail('INVALID_MANIFEST', 'Release and generated installer file paths overlap');
  }
  const changes = options.hosts.filter(host => host !== 'claude-code').map(host => configChange(host, host === 'codex' ? join(home, '.codex', 'hooks.json') : join(home, '.gemini', 'config', 'hooks.json'), files, node, target));
  let claude = null;
  if (options.hosts.includes('claude-code')) {
    if (!options.claude) fail('CLAUDE_PATH_REQUIRED', '--claude must name the existing absolute Claude Code CLI executable');
    const command = executable(options.claude, 'Claude Code');
    claude = { command, args: ['plugin', 'install', 'ssh-completion-client', '--marketplace', join(target, '.claude-marketplace'), '--scope', 'user', '--json'] };
  }
  safePath(target);
  let reuse = false;
  if (exists(target)) {
    if (!exists(target).isDirectory()) fail('TARGET_CONFLICT', 'Version target is not a directory');
    for (const [name, data] of files) {
      const current = readOptional(join(target, ...name.split('/')));
      if (!current || !current.equals(data)) fail('TARGET_CONFLICT', `Existing version differs: ${name}; use another version or restore the exact release`);
    }
    reuse = true;
  }
  const plan = { schemaVersion: '1.0.0', mode: options.apply ? 'apply' : 'plan', version: manifest.version, source, manifestSha256: options['manifest-sha256'], target, platform: process.platform, node, nodeVersion, reuse,
    files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: hash(data) })),
    configChanges: changes.map(change => ({ host: change.host, path: change.path, changed: change.changed, beforeSha256: change.before ? hash(change.before) : null, afterSha256: hash(change.after) })),
    claude, claudeRecovery: claude ? 'Only selected official plugin list metadata is backed up during apply; raw Claude settings, registries, and authentication stores are never read.' : null,
    reload: { automatic: false, codex: 'Start a new session; retain the host hook trust/enable requirements.', 'claude-code': 'Run /reload-plugins in Claude Code or start a new session; preserve host trust policy.', antigravity: 'Reload the Native application or start a new session; inspect Settings > Customizations > Hooks and preserve trust requirements.' },
    noAuthenticationOrPathChanges: true };
  // The plan pin describes the intended state independently of plan/apply mode.
  const planSha256 = hash(json({ ...plan, mode: 'plan' }));
  if (options['expect-plan'] && options['expect-plan'] !== planSha256) fail('PLAN_CHANGED', 'Inputs or host configuration changed since the reviewed plan; inspect a new plan');
  if (!options.apply) { process.stdout.write(JSON.stringify({ ...plan, planSha256 }) + '\n'); return; }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.install-client.lock');
  let lock;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('INSTALL_BUSY', `Installation lock exists: ${lockPath}; verify the owner process before manual recovery`); throw error; }
  const progress = { target, copied: false, configured: [], claude: claude ? 'not-started' : 'not-requested', backup: null };
  try {
    writeFileSync(lock, json({ pid: process.pid, target }));
    for (const change of changes) unchanged(change);
    const inventory = claude ? claudeRegistration(claude, manifest.version, target) : null;
    const registered = inventory?.state;
    if (registered) progress.claude = registered;
    if (!reuse) {
      mkdirSync(target, { mode: 0o700 });
      for (const [name, data] of files) writeNew(join(target, ...name.split('/')), data, name.endsWith('.sh') ? 0o700 : 0o600);
    }
    progress.copied = true;
    const pending = changes.filter(change => change.changed);
    // ponytail: one installer lock per root; noncooperating host writers are detected before replace, not locked by us.
    if (pending.length || (claude && !registered)) {
      progress.backup = join(root, 'backups', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID());
      mkdirSync(progress.backup, { recursive: true, mode: 0o700 });
      for (const change of pending) {
        unchanged(change);
        if (change.before) writeNew(join(progress.backup, change.host.replaceAll('/', '-') + '.before'), change.before);
      }
      if (claude) writeNew(join(progress.backup, 'claude-plugin.before.json'), json({ registration: inventory.metadata,
        recovery: 'Use the previous readFromFolder source with the official plugin install --marketplace command; preserve scope and enabled state. No raw Claude configuration was read or copied.' }));
      writeNew(join(progress.backup, 'plan.json'), json({ ...plan, planSha256 }));
    }
    for (const change of pending) { replaceConfig(change); progress.configured.push(change.host); }
    if (claude && !registered) {
      progress.claude = 'started';
      run(claude.command, claude.args, 'Claude official plugin installation (requires >=2.1.292)');
      progress.claude = 'official-cli-completed';
    }
    for (const [name, data] of files) if (!readOptional(join(target, ...name.split('/')))?.equals(data)) fail('POST_INSTALL_MISMATCH', `Installed file changed: ${name}`);
    for (const change of changes) if (!readOptional(change.path)?.equals(change.after)) fail('POST_INSTALL_MISMATCH', `Host configuration changed: ${change.host}`);
    process.stdout.write(JSON.stringify({ ...plan, planSha256, installed: true, progress, verification: { installedFiles: files.size, hostConfigFiles: changes.length, liveHostHooks: 'not-verified', claudeRegistration: claude ? 'official-cli-exit-0; verify plugin list/details and reload' : 'not-requested' } }) + '\n');
  } catch (error) {
    error.progress = progress;
    throw error;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

try { main(process.argv.slice(2)); }
catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'INSTALL_FAILED', message: error.message }, ...(error.progress ? { partialApply: error.progress, recovery: 'No automatic rollback. Preserve the version directory and backup; inspect the reported completed steps before retrying.' } : {}) }) + '\n');
  process.exitCode = 1;
}
