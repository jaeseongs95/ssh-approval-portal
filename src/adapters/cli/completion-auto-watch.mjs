import { spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { completionHookInput } from './completion-hook.mjs';
import { defaultCompletionInboxPath, validateCompletionDeliveryTarget } from './completion-delivery.mjs';
import { validateLocalPath } from './local-files.mjs';
import { openCompletionInbox } from './completion-inbox.mjs';

const fail = code => Object.assign(Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{48}(?![\s\S])/.test(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{16,128}(?![\s\S])/.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const target = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(value);
const states = new Set(['accepted', 'pending', 'evaluating', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired']);
const ignored = () => ({ state: 'ignored' });
function json(value) {
  if (object(value)) return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) return null;
  try { const parsed = JSON.parse(value); return object(parsed) ? parsed : null; } catch { return null; }
}
function contract(value) {
  const result = json(value);
  if (!result || result.isError === true) return null;
  if (result.structuredContent !== undefined) return json(result.structuredContent);
  if (Array.isArray(result.content)) {
    const texts = result.content.filter(item => item?.type === 'text');
    return texts.length === 1 ? json(texts[0].text) : null;
  }
  return result;
}
function callOf(host, input) {
  if (host !== 'antigravity') return { name: input.tool_name, args: json(input.tool_input), response: input.tool_response };
  const call = input.toolCall;
  if (!object(call)) return {};
  let name = call.name, args = json(call.args);
  if (name === 'call_mcp_tool' && args) {
    if (typeof args.ServerName !== 'string' || typeof args.ToolName !== 'string') return {};
    name = `mcp__${args.ServerName}__${args.ToolName}`;
    args = json(args.Arguments);
  }
  // Antigravity does not provide tool output. Use only the original stable lookup key/id.
  return { name, args };
}
async function readConfig(path) {
  validateLocalPath(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw fail('COMPLETION_AUTO_WATCH_CONFIG_INVALID');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value;
  try {
    const current = await fd.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size > 65536) throw fail('COMPLETION_AUTO_WATCH_CONFIG_INVALID');
    value = json(await fd.readFile('utf8'));
  } finally { await fd.close(); }
  if (!value || value.version !== 1 || !Array.isArray(value.routes)) throw fail('COMPLETION_AUTO_WATCH_CONFIG_INVALID');
  validateLocalPath(value.cloudflared);
  for (const route of value.routes) {
    let url;
    try { url = new URL(route.origin); } catch { throw fail('COMPLETION_AUTO_WATCH_CONFIG_INVALID'); }
    if (url.protocol !== 'https:' || url.origin !== route.origin || !Array.isArray(route.tools) || !route.tools.length ||
        route.tools.some(tool => typeof tool !== 'string' || !/^[A-Za-z0-9_-]{1,256}(?![\s\S])/.test(tool))) throw fail('COMPLETION_AUTO_WATCH_CONFIG_INVALID');
  }
  return value;
}

/** Native after-tool hook adapter. Starts the existing bounded client watch; no new service or MCP server. */
export async function autoWatchCompletion({ host, input, inboxPath, configPath, environment = process.env }, { spawn = spawnProcess, openInbox = openCompletionInbox } = {}) {
  if (!configPath) return ignored();
  if (!object(input) || input.error || !['PostToolUse', 'PostInvocation'].includes(input.hook_event_name)) return ignored();
  // PostInvocation has no operation payload; it remains an inbox-consumption boundary.
  if (input.hook_event_name === 'PostInvocation') return ignored();
  const observation = completionHookInput(host, input);
  const resolvedHost = observation.host;
  const config = await readConfig(configPath), call = callOf(resolvedHost, input);
  if (typeof call.name !== 'string') return ignored();
  const routes = config.routes.filter(route => route.tools.some(tool => call.name === tool || call.name.endsWith('__' + tool) || call.name.endsWith('_' + tool)));
  if (routes.length !== 1) return ignored();
  const route = routes[0], response = contract(call.response);
  const isObserve = /(?:^|_|__)observe$/.test(call.name);
  let selected, responseState = null;
  if (resolvedHost === 'antigravity') {
    if (!call.args) return ignored();
    const lookup = id(call.args.id) ? { operationId: call.args.id } : key(call.args.operationKey) ? { operationKey: call.args.operationKey } : null;
    if (!lookup) return ignored();
    // Source input can omit target for the server default. Never invent a revision.
    selected = { ...lookup, ...(target(call.args.target) && revision(call.args.expectedTargetRevision)
      ? { targetId: call.args.target, targetRevision: call.args.expectedTargetRevision } : {}) };
  } else {
    const data = response?.data;
    if (response?.contractVersion !== '2.0' || response.ok !== true || response.error !== null ||
        !object(data) || !id(data.id) || !states.has(data.state) || !target(data.targetId) || !revision(data.targetRevision)) return ignored();
    selected = { operationId: data.id, ...(key(data.operationKey) ? { operationKey: data.operationKey } : {}),
      targetId: data.targetId, targetRevision: data.targetRevision };
    responseState = data.state;
  }
  const location = inboxPath ?? defaultCompletionInboxPath(environment);
  const binding = validateCompletionDeliveryTarget({ host: resolvedHost, sessionId: observation.sessionId, inboxPath: location, environment }, { openInbox });
  const operationKey = selected.operationId ?? selected.operationKey;
  const inbox = openInbox({ filePath: location });
  let lease;
  try {
    if (responseState !== null && terminalStates.has(responseState)) {
      if (selected.operationId && typeof inbox.acknowledgeOperation === 'function') {
        inbox.acknowledgeOperation({ bindingId: binding.bindingId, operationId: selected.operationId });
      }
      return { state: 'settled', ...selected };
    }
    if (resolvedHost === 'antigravity' && isObserve && selected.operationId &&
        typeof inbox.hasOperationEvent === 'function' && inbox.hasOperationEvent({ bindingId: binding.bindingId, operationId: selected.operationId })) {
      if (typeof inbox.acknowledgeOperation === 'function') {
        inbox.acknowledgeOperation({ bindingId: binding.bindingId, operationId: selected.operationId });
      }
      return { state: 'settled', ...selected };
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([binding.bindingId, route.origin, operationKey])).digest('hex');
    lease = inbox.acquireWatch({ bindingId: binding.bindingId, watchKey: fingerprint });
    if (!lease.acquired) return { state: 'duplicate', ...selected };
    lease = { ...lease, fingerprint };
  } finally { inbox.close(); }
  const fingerprint = lease.fingerprint;
  const logPath = join(dirname(location), `auto-watch-${fingerprint}-${lease.ownerToken}.log`);
  let log;
  try {
    // A bounded lease suppresses concurrent readers, not future observation of the same remote operation.
    log = await open(logPath, 'wx', 0o600);
    const args = [fileURLToPath(new URL('../../../scripts/portal-files.mjs', import.meta.url)), '--origin', route.origin,
      '--cloudflared', config.cloudflared, 'watch',
      ...(selected.operationId ? [selected.operationId] : ['--operation-key', selected.operationKey]),
      '--notify-hook', '--host', resolvedHost, '--session', observation.sessionId, '--inbox', location,
      ...(selected.targetId ? ['--target', selected.targetId, '--expected-target-revision', selected.targetRevision] : [])];
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, shell: false,
      stdio: ['ignore', log.fd, log.fd], env: environment });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { state: 'started', ...selected };
  } catch {
    const inbox = openInbox({ filePath: location });
    try { inbox.releaseWatch({ bindingId: binding.bindingId, watchKey: fingerprint, ownerToken: lease.ownerToken }); }
    finally { inbox.close(); }
    throw fail('COMPLETION_AUTO_WATCH_START_FAILED');
  }
  finally { await log?.close(); }
}
