import { createRequire } from 'node:module';
import { loadConfig } from 'ssh-mcp/build/config/loader.js';
import { ConnectionRegistry } from 'ssh-mcp/build/ssh/connection-registry.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { SftpClient } from 'ssh-mcp/build/ssh/sftp.js';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';
import { preparePythonSource, preparePythonHelper } from './python-source.mjs';
import { validateAgentCliPlan, projectAgentCliResult } from './agent-cli.mjs';

/** Per-operation view: dispatch authorization follows every connect/retry wait. */
export function withDispatchGuard(connection, beforeDispatch = async () => {}) {
  return new Proxy(connection, { get(target, key, receiver) {
    if (key === 'ensureConnected') return async () => {
      await target.ensureConnected();
      await beforeDispatch();
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(key === 'exec' ? receiver : target) : value;
  } });
}

const defaultRedact = text => redactText(text, { entropyScan: true });
function commandOutcome(result, auditRedact = defaultRedact) {
  const failed = result.exitCode !== 0 || Boolean(result.signal);
  const stdout = auditRedact(result.stdout), stderr = auditRedact(result.stderr), parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (failed) parts.push(result.signal ? `[killed by SIG${result.signal}]` : `[exit ${result.exitCode}]`);
  return { failed, texts: [parts.join('\n\n')] };
}

/** Separate execution port, never approval authority. Reuse the pinned registry
 * and vendor's channel lifecycle. After dispatch, errors/exit codes do not prove
 * that no effect occurred and must never trigger a source replay.
 */
async function executeSourcePlan(registry, plan, verify, options = {}, prepare = preparePythonSource, beforeDispatch = async () => {}) {
  if (typeof verify !== 'function' || !plan?.manifest) throw Error('Source target verification required');
  const submitted = plan.manifest;
  const exact = prepare({ source: plan.stdin, argv: JSON.parse(submitted.argvJson), cwd: submitted.cwd, elevate: submitted.elevate,
    targetId: submitted.targetId, targetRevision: submitted.targetRevision, profile: submitted.profile, environmentRevision: submitted.environmentRevision });
  if (exact.command !== plan.command || exact.planDigest !== plan.planDigest
    || JSON.stringify(exact.manifest) !== JSON.stringify(submitted) || JSON.stringify(exact.args) !== JSON.stringify(plan.args)) throw Error('Source execution plan changed');
  const m = exact.manifest;
  const check = () => {
    const binding = verify();
    if (!binding || binding.targetId !== m.targetId || binding.targetRevision !== m.targetRevision || binding.profile !== m.profile) throw Error('Source target binding changed');
  };
  check();
  const connection = await registry.getOrCreate(m.profile);
  check();
  if (connection.profile.tty === true || connection.profile.readOnly !== false) throw Error('Source execution requires a writable non-TTY profile');
  if (connection.profile.workdir) throw Error('Source execution requires an explicit cwd without profile workdir');
  if (JSON.stringify(connection.profile) !== JSON.stringify(registry.getProfile(m.profile))) throw Error('Source SSH profile changed');
  const profileSnapshot = JSON.stringify(connection.profile);
  // The pinned exec() awaits/reconnects/retries before each getClient(). Use a
  // per-call view, never patch the shared connection or duplicate its lifecycle.
  // Its getClient() and client.exec() have no await between them in 2.18.0.
  const guarded = new Proxy(withDispatchGuard(connection, beforeDispatch), { get(target, key) {
    if (key === 'getClient') return () => {
      check();
      if (JSON.stringify(target.profile) !== profileSnapshot || JSON.stringify(registry.getProfile(m.profile)) !== profileSnapshot) throw Error('Source SSH profile changed');
      return target.getClient();
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let result;
  try { result = await connection.exec.call(guarded, exact.command, { stdin: exact.stdin, ...options }); }
  catch { throw Error('Source execution result unknown; do not retry automatically'); }
  return result;
}

export async function executePythonSource(registry, plan, verify, beforeDispatch = async () => {}) {
  return commandOutcome(await executeSourcePlan(registry, plan, verify, {}, preparePythonSource, beforeDispatch));
}

/** Fixed CLI helper only; not a generic raw-output or arbitrary-timeout escape hatch. */
export async function executeAgentCli(registry, plan, verify, beforeDispatch = async () => {}) {
  const exact = validateAgentCliPlan(plan);
  const timeoutMs = ['install','update'].includes(exact.agentCli.action) ? 930000 : 30000;
  let result;
  try { result = await executeSourcePlan(registry, exact, verify, { timeoutMs }, preparePythonHelper, beforeDispatch); }
  catch { throw Error('CLI result unknown; inspect saved status, never retry automatically'); }
  return projectAgentCliResult(result, exact);
}

/** The only adapter coupled to ssh-mcp's versioned internal modules. */
export async function createSshRuntime(settings) {
  if (createRequire(import.meta.url)('ssh-mcp/package.json').version !== '2.18.0') throw Error('Requires ssh-mcp 2.18.0');
  for (const [key, value] of Object.entries(settings)) if (key.startsWith('SSH_MCP_')) process.env[key] = value;
  const config = await loadConfig(settings.BRIDGE_CONFIG_PATH);
  const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');
  const auditRedact = defaultRedact;
  return {
    registry, classify: classifyCommand, auditRedact,
    async executeCommand(profile, command, beforeDispatch = async () => {}) {
      const result = await withDispatchGuard(await registry.getOrCreate(profile), beforeDispatch).exec(command);
      return commandOutcome(result, auditRedact);
    },
    executePythonSource: (plan, verify, beforeDispatch) => executePythonSource(registry, plan, verify, beforeDispatch),
    executeAgentCli: (plan, verify, beforeDispatch) => executeAgentCli(registry, plan, verify, beforeDispatch),
  };
}

/** Connections expose a narrow transport contract, never vendor profile objects. */
export function createSshTransport(registry) {
  return {
    async connect(profile, { beforeDispatch } = {}) {
      const connection = withDispatchGuard(await registry.getOrCreate(profile), beforeDispatch);
      const idleTimeoutMs = connection.profile.transferTimeoutMs;
      return {
        call(command, payload) { return connection.exec(command, { stdin: JSON.stringify(payload), timeoutMs: idleTimeoutMs }); },
        upload(source, remotePath, { maxBytes }) {
          return new SftpClient(connection).uploadFile(source, remotePath, { maxBytes, idleTimeoutMs, overwrite: false, mode: 0o600 });
        },
        download(remotePath, destination, { maxBytes }) {
          return new SftpClient(connection).downloadFile(remotePath, destination, { maxBytes, idleTimeoutMs });
        },
      };
    },
  };
}
