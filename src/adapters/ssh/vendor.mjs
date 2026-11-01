import { createRequire } from 'node:module';
import { loadConfig } from 'ssh-mcp/build/config/loader.js';
import { ConnectionRegistry } from 'ssh-mcp/build/ssh/connection-registry.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { SftpClient } from 'ssh-mcp/build/ssh/sftp.js';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';
import { preparePythonSource, preparePythonHelper } from './python-source.mjs';
import { validateAgentCliPlan, projectAgentCliResult } from './agent-cli.mjs';
import { windowsRemotePath } from '../../domain/validation.mjs';
import { executionFailure } from '../../domain/execution-failure.mjs';
import { acquireSshConnection, withConnectionLifecycle, rawSshClient } from './connection-lifecycle.mjs';

/** Per-operation view: dispatch authorization follows every connect/retry wait. */
export function withDispatchGuard(connection, beforeDispatch = async () => {}, verifyConnection = () => {}, { connectedOnly = false, clientView = client => client } = {}) {
  return new Proxy(connection, { get(target, key, receiver) {
    if (key === 'ensureConnected') return async () => {
      verifyConnection();
      if (connectedOnly) {
        if (!target.isConnected()) throw Error('Original cleanup connection unavailable');
      } else await target.ensureConnected();
      await beforeDispatch();
    };
    if (key === 'getClient') return () => {
      beforeDispatch.verify?.();
      verifyConnection();
      const client = target.getClient();
      return clientView(client);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(key === 'exec' ? receiver : target) : value;
  } });
}

async function connectionBinding(registry, profile) {
  const configured = registry.getProfile && JSON.stringify(registry.getProfile(profile));
  const connection = await acquireSshConnection(registry, profile);
  const snapshot = configured ?? JSON.stringify(connection.profile);
  const verify = () => {
    if (JSON.stringify(connection.profile) !== snapshot || registry.getProfile && JSON.stringify(registry.getProfile(profile)) !== snapshot) throw Error('SSH dispatch profile changed');
  };
  return { connection, verify };
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
    targetId: submitted.targetId, targetRevision: submitted.targetRevision, profile: submitted.profile, environmentRevision: submitted.environmentRevision, ...(submitted.platform === 'windows' ? { platform: 'windows', pythonExecutable: submitted.interpreter } : {}) });
  if (exact.command !== plan.command || exact.planDigest !== plan.planDigest
    || exact.transportStdin !== plan.transportStdin
    || JSON.stringify(exact.manifest) !== JSON.stringify(submitted) || JSON.stringify(exact.args) !== JSON.stringify(plan.args)) throw Error('Source execution plan changed');
  const m = exact.manifest;
  const check = () => {
    const binding = verify();
    if (!binding || binding.targetId !== m.targetId || binding.targetRevision !== m.targetRevision || binding.profile !== m.profile) throw Error('Source target binding changed');
  };
  check();
  const connection = await acquireSshConnection(registry, m.profile);
  check();
  if (connection.profile.tty === true || connection.profile.readOnly !== false) throw Error('Source execution requires a writable non-TTY profile');
  if (connection.profile.workdir) throw Error('Source execution requires an explicit cwd without profile workdir');
  if (JSON.stringify(connection.profile) !== JSON.stringify(registry.getProfile(m.profile))) throw Error('Source SSH profile changed');
  const profileSnapshot = JSON.stringify(connection.profile);
  // The pinned exec() awaits/reconnects/retries before each getClient(). Use a
  // per-call view, never patch the shared connection or duplicate its lifecycle.
  // Its getClient() and client.exec() have no await between them in 2.18.0.
  const execute = observed => {
    const guarded = new Proxy(withDispatchGuard(observed, beforeDispatch), { get(target, key) {
      if (key === 'getClient') return () => {
        check();
        if (JSON.stringify(target.profile) !== profileSnapshot || JSON.stringify(registry.getProfile(m.profile)) !== profileSnapshot) throw Error('Source SSH profile changed');
        return target.getClient();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return connection.exec.call(guarded, exact.command, { stdin: exact.transportStdin ?? exact.stdin, ...options });
  };
  try { return await withConnectionLifecycle(connection, execute); }
  catch (error) {
    const failure = executionFailure(error, { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED' });
    failure.message = 'Source execution result unknown; do not retry automatically'; throw failure;
  }
}

export async function executePythonSource(registry, plan, verify, beforeDispatch = async () => {}) {
  return commandOutcome(await executeSourcePlan(registry, plan, verify, {}, preparePythonSource, beforeDispatch));
}

/** Fixed CLI helper only; not a generic raw-output or arbitrary-timeout escape hatch. */
export async function executeAgentCli(registry, plan, verify, beforeDispatch = async () => {}) {
  const exact = validateAgentCliPlan(plan);
  const timeoutMs = ['install','update'].includes(exact.agentCli.action) ? 930000 : 30000;
  let result;
  const prepare = exact.manifest.contract === 'agent-cli-powershell-v1' ? () => validateAgentCliPlan(exact) : preparePythonHelper;
  try { result = await executeSourcePlan(registry, exact, verify, { timeoutMs }, prepare, beforeDispatch); }
  catch (error) {
    const failure = executionFailure(error, { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED' });
    failure.message = 'CLI result unknown; inspect saved status, never retry automatically'; throw failure;
  }
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
    async executeCommand(profile, command, beforeDispatch = async () => {}, options = {}) {
      if (Object.keys(options).some(key => key !== 'stdin') || options.stdin !== undefined && typeof options.stdin !== 'string') throw Error('Invalid command transport options');
      const binding = await connectionBinding(registry, profile);
      const result = await withConnectionLifecycle(binding.connection, observed => withDispatchGuard(observed, beforeDispatch, binding.verify).exec(command, options));
      return commandOutcome(result, auditRedact);
    },
    executePythonSource: (plan, verify, beforeDispatch) => executePythonSource(registry, plan, verify, beforeDispatch),
    executeAgentCli: (plan, verify, beforeDispatch) => executeAgentCli(registry, plan, verify, beforeDispatch),
  };
}

/** Connections expose a narrow transport contract, never vendor profile objects. */
export function createSshTransport(registry) {
  return {
    async connect(profile, { beforeDispatch, cleanup } = {}) {
      // Cleanup is a single fixed helper action, never a caller-supplied command/path.
      let cleanupCommand, cleanupInput;
      if (cleanup !== undefined) {
        if (!cleanup || Object.keys(cleanup).some(key => !['platform', 'helper', 'id'].includes(key)) || !/^[a-f0-9]{48}$/.test(cleanup.id)) throw Error('Invalid cleanup binding');
        if (cleanup.platform === 'windows') {
          windowsRemotePath(cleanup.helper);
          if (!/^[A-Za-z]:[\\/][A-Za-z0-9_./\\ -]+$/.test(cleanup.helper)) throw Error('Invalid cleanup helper');
          cleanupCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cleanup.helper}"`;
        } else if (cleanup.platform === 'linux' && /^\/[A-Za-z0-9_./-]+$/.test(cleanup.helper)) cleanupCommand = cleanup.helper;
        else throw Error('Invalid cleanup helper');
        cleanupInput = JSON.stringify({ action: 'cleanup', id: cleanup.id });
      }
      const binding = await connectionBinding(registry, profile);
      let originalClient, originalConnection, originalVerify, attempted = false;
      const clientView = (client, current) => new Proxy(client, { get(target, key) {
        if (key === 'exec' || key === 'sftp') return (...args) => {
          const callback = args.pop();
          attempted = true;
          return target[key](...args, (error, channel) => {
            if (!error && !originalClient) {
              originalClient = rawSshClient(target); originalConnection = current.connection; originalVerify = current.verify;
            }
            callback(error, channel);
          });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const perform = async action => {
        const current = await connectionBinding(registry, profile);
        return withConnectionLifecycle(current.connection, observed => action(withDispatchGuard(observed, beforeDispatch, current.verify, { clientView: client => clientView(client, current) })));
      };
      const idleTimeoutMs = binding.connection.profile.transferTimeoutMs;
      const verifyCleanup = () => {
        beforeDispatch?.cleanup?.();
        originalVerify?.();
        if (!originalClient || !originalConnection.isConnected() || originalConnection.getClient() !== originalClient) throw Error('Original cleanup connection changed');
      };
      const cleanupGuard = async () => verifyCleanup();
      cleanupGuard.verify = verifyCleanup;
      return {
        ...(cleanupCommand === undefined ? {} : { cleanup() {
          if (!originalClient) {
            // A request with no confirmed channel can still have reached the host.
            if (attempted) throw Error('Remote staging outcome unconfirmed');
            return Promise.resolve({ exitCode: 0, stdout: '{"cleaned":true}' });
          }
          verifyCleanup();
          return withConnectionLifecycle(originalConnection, observed => withDispatchGuard(observed, cleanupGuard, originalVerify, { connectedOnly: true }).exec(cleanupCommand, { stdin: cleanupInput, timeoutMs: idleTimeoutMs }));
        } }),
        call(command, payload) { return perform(connection => connection.exec(command, { stdin: JSON.stringify(payload), timeoutMs: idleTimeoutMs })); },
        upload(source, remotePath, { maxBytes }) {
          return perform(connection => new SftpClient(connection).uploadFile(source, remotePath, { maxBytes, idleTimeoutMs, overwrite: false, mode: 0o600 }));
        },
        download(remotePath, destination, { maxBytes }) {
          return perform(connection => new SftpClient(connection).downloadFile(remotePath, destination, { maxBytes, idleTimeoutMs }));
        },
      };
    },
  };
}
