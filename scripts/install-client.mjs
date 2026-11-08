#!/usr/bin/env node
// Standalone installer: only Node built-ins; authentication and PATH are untouched.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { resolve, dirname, basename, join, isAbsolute, relative, delimiter } from 'node:path';
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
  const resolvedPin = pin === 'auto' ? hash(manifestBytes) : pin;
  if (hash(manifestBytes) !== resolvedPin) fail('MANIFEST_HASH_MISMATCH', 'Manifest does not match --manifest-sha256');
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
  for (const name of ['LICENSE', 'scripts/portal-files.mjs', 'hooks/codex.json', 'hooks/claude-code.json', 'hooks/antigravity.json']) {
    if (!files.has(name)) fail('INVALID_MANIFEST', `Required client file missing: ${name}`);
  }
  files.set('client-manifest.json', manifestBytes);
  return { manifest, files, manifestSha256: resolvedPin };
}

function executable(path, label) {
  if (!isAbsolute(path) || /[\x00\r\n]/.test(path)) fail('EXECUTABLE_INVALID', `${label} must be an existing absolute executable path`);
  const actual = realpathSync(path);
  if (!lstatSync(actual).isFile()) fail('EXECUTABLE_INVALID', `${label} is not a regular executable`);
  return actual;
}

function discoverExecutable(names, extraDirs = [], envVar) {
  const explicitEnv = envVar ? process.env[envVar] : undefined;
  if (explicitEnv) {
    try { return executable(explicitEnv, envVar); } catch { /* ignore invalid env and continue or fail at caller */ }
  }
  const pathValue = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const dirs = [...extraDirs, ...(typeof pathValue === 'string' && pathValue.length <= 32768 ? pathValue.split(delimiter).slice(0, 256) : [])];
  for (const raw of dirs) {
    const dir = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        safePath(candidate);
        if (exists(candidate)?.isFile()) return executable(candidate, name);
      } catch { /* skip unusable PATH entry */ }
    }
  }
  return null;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  // Do not echo third-party stdout/stderr: host output can contain private settings.
  if (result.error || result.status !== 0) {
    let reported;
    for (const line of (result.stdout ?? '').trim().split('\n').reverse()) {
      try { reported = JSON.parse(line); break; } catch { /* Only structured host codes are eligible for disclosure. */ }
    }
    const code = reported?.failureCode ?? reported?.code;
    const safeCodes = new Set(['name_taken', 'not_found', 'plugin_not_found', 'marketplace_not_found', 'invalid_source', 'invalid_scope', 'not_installed', 'permission_denied', 'policy_blocked']);
    const hostCode = typeof code === 'string' && safeCodes.has(code) ? code : null;
    throw Object.assign(new Error(`${label} failed (${result.error?.code ?? `exit ${result.status}`}${hostCode ? `; hostCode=${hostCode}` : ''}); inspect the host CLI directly`),
      { code: 'HOST_COMMAND_FAILED', ...(hostCode ? { hostCode } : {}) });
  }
  return result.stdout;
}

const marketplaceName = 'ssh-mcp-client-local';
const pluginName = 'ssh-completion-client';
const pluginId = `${pluginName}@${marketplaceName}`;
const pluginMetadata = plugin => Object.fromEntries(['id', 'version', 'scope', 'enabled', 'readFromFolder', 'folderVersion'].map(key => [key, plugin[key] ?? null]));
function hostList(claude, args, label, key) {
  let result;
  try { result = JSON.parse(run(claude.command, args, label)); }
  catch (error) { if (error.code) throw error; fail('CLAUDE_INVENTORY_INVALID', `${label} did not return JSON`); }
  const list = Array.isArray(result) ? result : result?.[key];
  if (!Array.isArray(list) || list.some(value => !object(value))) fail('CLAUDE_INVENTORY_INVALID', `${label} has an unsupported JSON shape`);
  return list;
}

function ownedMarketplace(path, target) {
  const installRoot = dirname(target);
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== '.claude-marketplace'
      || resolve(dirname(dirname(path))) !== resolve(installRoot)
      || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(basename(dirname(path)))) {
    fail('CLAUDE_MARKETPLACE_CONFLICT', 'Existing marketplace is outside this installer root; its source will not be changed');
  }
  if (!exists(path)) return;
  const data = readOptional(join(path, '.claude-plugin', 'marketplace.json'));
  let catalog;
  try { catalog = JSON.parse(data?.toString('utf8') ?? 'null'); } catch { /* Report the ownership boundary without source contents. */ }
  if (catalog?.name !== marketplaceName || !Array.isArray(catalog.plugins) || catalog.plugins.length !== 1
      || catalog.plugins[0]?.name !== pluginName || catalog.plugins[0]?.source !== './plugins/ssh-completion-client') {
    fail('CLAUDE_MARKETPLACE_CONFLICT', 'Existing marketplace is not the dedicated one-plugin SSH client catalog');
  }
  const pluginBytes = readOptional(join(path, 'plugins', pluginName, '.claude-plugin', 'plugin.json'));
  let manifest;
  try { manifest = JSON.parse(pluginBytes?.toString('utf8') ?? 'null'); } catch { /* Ownership must be established before changing a source. */ }
  if (manifest?.name !== pluginName || manifest.version !== basename(dirname(path))) fail('CLAUDE_MARKETPLACE_CONFLICT', 'Existing marketplace plugin metadata does not match its managed version directory');
}

function unrelatedPlugins(plugins) {
  return plugins.filter(plugin => !(plugin.id === pluginId && plugin.scope === 'user'))
    .map(pluginMetadata).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function claudeRegistration(claude, version, target) {
  const plugins = hostList(claude, ['plugin', 'list', '--json'], 'Claude plugin inventory', 'plugins');
  const marketplaces = hostList(claude, ['plugin', 'marketplace', 'list', '--json'], 'Claude marketplace inventory', 'marketplaces');
  const own = plugins.filter(plugin => plugin.id === pluginId && plugin.scope === 'user');
  if (own.length > 1) fail('CLAUDE_INVENTORY_INVALID', 'Multiple user registrations exist for the SSH completion plugin');
  const plugin = own[0];
  if (plugin && typeof plugin.enabled !== 'boolean') fail('CLAUDE_INVENTORY_INVALID', 'Existing plugin enabled state is not explicit');
  const entries = marketplaces.filter(entry => entry.name === marketplaceName);
  if (entries.length > 1) fail('CLAUDE_INVENTORY_INVALID', 'Multiple marketplace sources use the SSH client name');
  const marketplace = entries[0];
  if (marketplace) {
    if (marketplace.source !== 'directory') fail('CLAUDE_MARKETPLACE_CONFLICT', 'The SSH marketplace name belongs to a non-directory source');
    ownedMarketplace(marketplace.path, target);
  } else if (plugin) fail('CLAUDE_INVENTORY_INVALID', 'The installed SSH plugin has no corresponding marketplace source');
  const expected = join(target, '.claude-marketplace', 'plugins', pluginName);
  const marketplaceExists = Boolean(marketplace && exists(marketplace.path));
  const same = plugin?.version === version && (plugin.folderVersion == null || plugin.folderVersion === version)
    && typeof plugin.readFromFolder === 'string' && resolve(plugin.readFromFolder) === resolve(expected)
    && marketplaceExists && resolve(marketplace.path) === resolve(join(target, '.claude-marketplace'));
  if (!same && plugins.some(item => typeof item.id === 'string' && item.id.endsWith('@' + marketplaceName)
      && (item.id !== pluginId || item.scope !== 'user'))) {
    fail('CLAUDE_SCOPE_CONFLICT', 'Another plugin or installation scope shares this marketplace; its source will not be changed');
  }
  if (plugin && (!marketplace || (marketplaceExists && (typeof plugin.readFromFolder !== 'string'
      || resolve(plugin.readFromFolder) !== resolve(join(marketplace.path, 'plugins', pluginName)))))) {
    fail('CLAUDE_MARKETPLACE_CONFLICT', 'Existing SSH plugin source does not match the owned marketplace');
  }
  const metadata = plugin ? pluginMetadata(plugin) : null;
  return { state: same ? (plugin.enabled === false ? 'already-registered-disabled' : 'already-registered') : null,
    metadata, marketplace: marketplace ? { name: marketplace.name, source: marketplace.source, path: marketplace.path } : null,
    unrelatedSha256: hash(json(unrelatedPlugins(plugins))), expectedEnabled: plugin ? plugin.enabled : true };
}

function shellWord(value) {
  if (process.platform !== 'win32') return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/["%!^\r\n\x00]/.test(value)) fail('UNSUPPORTED_SHELL_PATH', 'Windows command paths cannot contain quotes, percent, exclamation, or caret');
  return '"' + value + '"';
}
const psWord = value => "'" + value.replaceAll("'", "''") + "'";
function hookCommand(node, script, host, event, watchConfig) {
  return [shellWord(node), shellWord(script), '--host', host, ...(event ? ['--event', event] : []),
    ...(watchConfig ? ['--watch-config', shellWord(watchConfig)] : [])].join(' ');
}

function parsedConfig(before, label) {
  if (!before) return {};
  let value;
  try { value = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('HOST_CONFIG_INVALID', `${label} hook configuration is not JSON`); }
  if (!object(value)) fail('HOST_CONFIG_INVALID', `${label} hook configuration must be an object`);
  return value;
}
const sshHandler = handler => object(handler) && [handler.command, handler.commandWindows, ...(Array.isArray(handler.args) ? handler.args : [])].some(value => typeof value === 'string' && /(?:^|[\\/])(?:portal-completion-hook|portal-files)\.mjs(?:["'\s]|$)/.test(value));

function configChange(host, path, files, node, target) {
  const before = readOptional(path), body = parsedConfig(before, host);
  const script = join(target, 'scripts', 'portal-files.mjs');
  const watchConfig = files.has('completion-watch.json') ? join(target, 'completion-watch.json') : undefined;
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
        handler.command = hookCommand(node, script, 'codex', undefined, watchConfig);
        handler.commandWindows = '& ' + psWord(node) + ' ' + psWord(script) + ' --host codex' +
          (watchConfig ? ' --watch-config ' + psWord(watchConfig) : '');
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
      for (const handler of handlers) handler.command = hookCommand(node, script, 'antigravity', event, watchConfig);
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
  const routes = [];
  for (const mode of ['test', 'prod']) {
    if (!options[`${mode}-origin`]) continue;
    const tools = options[`${mode}-mcp-tools`]?.split(',') ?? (mode === 'test'
      ? ['ssh_test_submit', 'ssh_test_observe', 'ssh-test_submit', 'ssh-test_observe', 'mcp__ssh-test__submit', 'mcp__ssh-test__observe']
      : ['ssh_approval_bridge_submit', 'ssh_approval_bridge_observe', 'ssh-approval-bridge_submit', 'ssh-approval-bridge_observe', 'mcp__ssh-approval-bridge__submit', 'mcp__ssh-approval-bridge__observe']);
    if (tools.some(tool => !/^[A-Za-z0-9_-]{1,256}(?![\s\S])/.test(tool))) fail('INVALID_ARGUMENT', 'MCP tool names must be comma-separated identifiers');
    routes.push({ origin: origin(options[`${mode}-origin`]), tools });
  }
  if (routes.length) {
    if (!options.cloudflared) fail('CLOUDFLARED_REQUIRED', 'Existing cloudflared is required for automatic observation');
    add('completion-watch.json', json({ version: 1, cloudflared: executable(options.cloudflared, 'cloudflared'), routes }));
  }
  if (windows) { shellWord(node); shellWord(target); }
  const defaultCloudflared = options.cloudflared ? executable(options.cloudflared, 'cloudflared') : undefined;
  for (const [name, entry] of [['portal-files', 'portal-files.mjs']]) {
    const script = join(target, 'scripts', entry);
    const cfArgsPs = defaultCloudflared ? ` --cloudflared ${psWord(defaultCloudflared)}` : '';
    const cfArgsSh = defaultCloudflared ? ` --cloudflared ${shellWord(defaultCloudflared)}` : '';
    if (windows) {
      // ASCII-only CMD delegates Unicode path handling to the BOM-tagged PS1.
      add(`${name}.cmd`, `@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File "%~dp0${name}.ps1" %*\r\nexit /b %errorlevel%\r\n`);
      add(`${name}.ps1`, `& ${psWord(node)} ${psWord(script)}${cfArgsPs} @args\nexit $LASTEXITCODE\n`);
    } else add(`${name}.sh`, `#!/bin/sh\nexec ${shellWord(node)} ${shellWord(script)}${cfArgsSh} "$@"\n`);
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
      handler.args = handler.args.map(arg => arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/(?:portal-completion-hook|portal-files)\.mjs/, join(target, 'scripts', 'portal-files.mjs')));
      if (routes.length) handler.args.push('--watch-config', join(target, 'completion-watch.json'));
    }
    add(prefix + '.claude-plugin/plugin.json', json({ name: 'ssh-completion-client', version, description: 'SSH MCP client native completion hooks', author: { name: 'SSH MCP client' }, hooks: './hooks/claude-code.json' }));
    add(prefix + 'hooks/claude-code.json', json(hooks));
    add(prefix + 'LICENSE', files.get('LICENSE'));
    add(prefix + 'README.md', `# SSH completion client ${version}\n\nNative completion hooks for this installed SSH MCP client. Use the documented host reload and trust controls; credentials are not included.\n`);
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
  const values = new Set(['source', 'manifest-sha256', 'install-root', 'home', 'node', 'cloudflared', 'test-origin', 'prod-origin', 'test-mcp-tools', 'prod-mcp-tools', 'hosts', 'claude', 'expect-plan']);
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
    process.stdout.write('Usage: node scripts/install-client.mjs --manifest-sha256 SHA256|auto [--source EXTRACTED] [--install-root DIR] [--home DIR] [--hosts codex,claude-code,antigravity|none] [--node ABSOLUTE] [--claude ABSOLUTE] [--cloudflared ABSOLUTE --test-origin HTTPS --prod-origin HTTPS] [--apply] [--expect-plan SHA256]\nDefault: read-only plan. Install root contains a separate directory for each version. See docs/client-install.ko.md.\n');
    return;
  }
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) fail('PLATFORM_UNSUPPORTED', 'Supported installer platforms: Windows, Linux, macOS');
  if (options['manifest-sha256'] !== 'auto' && !/^[a-f0-9]{64}$/.test(options['manifest-sha256'] ?? '')) fail('MANIFEST_PIN_REQUIRED', 'Pass the trusted release manifest SHA-256 using --manifest-sha256 (or --manifest-sha256 auto)');
  options.hosts = (options.hosts ?? 'none').split(',');
  if (options.hosts.length === 1 && options.hosts[0] === 'none') options.hosts = [];
  if (new Set(options.hosts).size !== options.hosts.length || options.hosts.some(host => !['codex', 'claude-code', 'antigravity'].includes(host))) fail('INVALID_HOST', 'Choose codex, claude-code, antigravity, or none; Gemini CLI is not Antigravity');
  const home = resolve(options.home ?? homedir());
  if (options.hosts.includes('claude-code') && home !== resolve(homedir())) fail('CLAUDE_HOME_UNSUPPORTED', 'Claude registration uses the actual user home; a custom --home supports only Codex/Antigravity fixture or custom configuration');
  const source = resolve(options.source ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const root = resolve(options['install-root'] ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'ssh-approval-portal-client') : join(home, '.local', 'share', 'ssh-approval-portal-client')));
  safePath(source); safePath(root); safePath(home);
  const { manifest, files, manifestSha256 } = bundle(source, options['manifest-sha256']);
  options['manifest-sha256'] = manifestSha256;
  if ((options['test-origin'] || options['prod-origin']) && !options.cloudflared) {
    options.cloudflared = discoverExecutable(process.platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared'], [], 'PORTAL_CLOUDFLARED') ?? undefined;
  }
  if (options.hosts.includes('claude-code') && !options.claude) {
    options.claude = discoverExecutable(process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'], [join(home, '.local', 'bin')]) ?? undefined;
  }
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
    claude = { command,
      sourceArgs: ['plugin', 'marketplace', 'add', join(target, '.claude-marketplace'), '--scope', 'user', '--json'],
      installArgs: ['plugin', 'install', pluginId, '--scope', 'user', '--json'],
      updateArgs: ['plugin', 'update', pluginId, '--scope', 'user', '--json'] };
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
  // Only official read-only inventories participate in a reviewed Claude plan.
  const claudeBefore = claude ? claudeRegistration(claude, manifest.version, target) : null;
  const plan = { schemaVersion: '1.0.0', mode: options.apply ? 'apply' : 'plan', version: manifest.version, source, manifestSha256: options['manifest-sha256'], target, platform: process.platform, node, nodeVersion, reuse,
    files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: hash(data) })),
    configChanges: changes.map(change => ({ host: change.host, path: change.path, changed: change.changed, beforeSha256: change.before ? hash(change.before) : null, afterSha256: hash(change.after) })),
    claude, claudeBefore, claudeRecovery: claude ? 'Only selected official plugin/marketplace metadata is backed up during apply; raw Claude settings, registries, and authentication stores are never read.' : null,
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
  const progress = { target, copied: false, configured: [], claude: claude ? 'not-started' : 'not-requested', claudeSteps: [], backup: null };
  try {
    writeFileSync(lock, json({ pid: process.pid, target }));
    for (const change of changes) unchanged(change);
    const inventory = claude ? claudeRegistration(claude, manifest.version, target) : null;
    if (claude && hash(json(inventory)) !== hash(json(claudeBefore))) fail('CLAUDE_SOURCE_CHANGED', 'Official plugin or marketplace inventory changed after planning; inspect a new plan before applying');
    const registered = inventory?.state;
    if (claude) { progress.claudeSteps.push('inventory-verified'); progress.claude = registered ?? 'inventory-verified'; }
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
      if (claude) writeNew(join(progress.backup, 'claude-plugin.before.json'), json({ registration: inventory.metadata, marketplace: inventory.marketplace, unrelatedPluginsSha256: inventory.unrelatedSha256,
        recovery: 'Use official plugin marketplace add PREVIOUS_SOURCE --scope user, then qualified plugin update --scope user; preserve enabled state. No raw Claude configuration was read or copied.' }));
      writeNew(join(progress.backup, 'plan.json'), json({ ...plan, planSha256 }));
    }
    for (const change of pending) { replaceConfig(change); progress.configured.push(change.host); }
    if (claude && !registered) {
      progress.claude = 'marketplace-add-started';
      run(claude.command, claude.sourceArgs, 'Claude official marketplace source registration');
      progress.claudeSteps.push('marketplace-added');
      const update = Boolean(inventory.metadata);
      progress.claude = update ? 'plugin-update-started' : 'plugin-install-started';
      run(claude.command, update ? claude.updateArgs : claude.installArgs, update ? 'Claude official qualified plugin update' : 'Claude official qualified plugin installation');
      progress.claudeSteps.push(update ? 'plugin-updated' : 'plugin-installed');
    }
    if (claude) {
      progress.claude = 'post-inventory-started';
      const after = claudeRegistration(claude, manifest.version, target);
      if (!after.state || after.metadata.enabled !== inventory.expectedEnabled || after.unrelatedSha256 !== inventory.unrelatedSha256) {
        fail('CLAUDE_POST_INSTALL_MISMATCH', 'Official inventory did not confirm the expected version, source, scope, enabled state, and unchanged unrelated plugins');
      }
      progress.claude = registered ?? 'verified';
      progress.claudeSteps.push('post-inventory-verified');
    }
    for (const [name, data] of files) if (!readOptional(join(target, ...name.split('/')))?.equals(data)) fail('POST_INSTALL_MISMATCH', `Installed file changed: ${name}`);
    for (const change of changes) if (!readOptional(change.path)?.equals(change.after)) fail('POST_INSTALL_MISMATCH', `Host configuration changed: ${change.host}`);
    process.stdout.write(JSON.stringify({ ...plan, planSha256, installed: true, progress, verification: { installedFiles: files.size, hostConfigFiles: changes.length, liveHostHooks: 'not-verified', claudeRegistration: claude ? 'official-inventory-version-source-user-scope-enabled-and-unrelated-plugins-verified; reload required' : 'not-requested' } }) + '\n');
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
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'INSTALL_FAILED', message: error.message, ...(error.hostCode ? { hostCode: error.hostCode } : {}) }, ...(error.progress ? { partialApply: error.progress, recovery: 'No automatic rollback. Preserve the version directory and backup; inspect the reported completed steps before retrying.' } : {}) }) + '\n');
  process.exitCode = 1;
}
