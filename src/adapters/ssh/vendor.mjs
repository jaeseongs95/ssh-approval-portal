import { createRequire } from 'node:module';
import { loadConfig } from 'ssh-mcp/build/config/loader.js';
import { ConnectionRegistry } from 'ssh-mcp/build/ssh/connection-registry.js';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { SftpClient } from 'ssh-mcp/build/ssh/sftp.js';
import { redactText } from 'ssh-mcp/build/guard/redactor.js';
import { preparePythonSource, preparePythonHelper } from './python-source.mjs';
import { validateAgentCliPlan, projectAgentCliResult } from './agent-cli.mjs';
import { windowsRemotePath } from '../../domain/validation.mjs';
import { executionFailure, executionFailureDetails } from '../../domain/execution-failure.mjs';
import { dispatchRefusal, dispatchFailureDetails } from '../../domain/dispatch-failure.mjs';
import { acquireSshConnection, withConnectionLifecycle, rawSshClient } from './connection-lifecycle.mjs';
import { superviseExecution, presentStderr, DEFAULT_RUN_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES } from './execution-supervisor.mjs';

const isDispatchRefusal = error => dispatchFailureDetails(error).dispatchFailureStage !== 'unknown';
// This helper is called only before client.exec, never around its Promise/result.
function notDispatched(error) {
  if (isDispatchRefusal(error)) return error;
  const previous = executionFailureDetails(error, false);
  const failure = executionFailure(Error('Command was not dispatched'), { stage: previous?.stage ?? 'ssh_execution', code: previous?.code ?? 'SSH_EXECUTION_FAILED', remoteOutcome: 'not_started' });
  failure.message = 'SSH execution unavailable before dispatch';
  return failure;
}

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
  let connection;
  try { connection = await acquireSshConnection(registry, profile); } catch (error) { throw notDispatched(error); }
  const snapshot = configured ?? JSON.stringify(connection.profile);
  const verify = () => {
    if (JSON.stringify(connection.profile) !== snapshot || registry.getProfile && JSON.stringify(registry.getProfile(profile)) !== snapshot) dispatchRefusal('target_changed', 'target_guard', 'SSH dispatch profile changed');
  };
  return { connection, verify };
}

const defaultRedact = text => redactText(text, { entropyScan: true });
function validateExecutionOptions(options, allowStdin = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['timeoutMs', 'stopGraceMs', 'signal', 'onOutput', 'maxOutputBytes', ...(allowStdin ? ['stdin'] : [])].includes(key))) throw Error('Invalid command transport options');
}
function commandOutcome(result, auditRedact = defaultRedact) {
  const failed = result.exitCode !== 0 || Boolean(result.signal) || result.execution.reason !== 'exit' || result.execution.captureFailed || !result.execution.cleanupComplete;
  const stdout = auditRedact(result.stdout), rawStderr = auditRedact(result.stderr), stderr = presentStderr(rawStderr), parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);
  if (failed) parts.push(result.execution.captureFailed ? '[output capture failed]' : !result.execution.cleanupComplete && result.execution.reason === 'exit' ? '[channel cleanup unconfirmed]'
    : result.execution.reason !== 'exit' ? `[execution ${result.execution.reason}; remote ${result.execution.remoteState}; automatic replay disabled]`
    : result.signal ? `[killed by SIG${result.signal}]` : `[exit ${result.exitCode}]`);
  if (result.execution.stdout.truncated || result.execution.stderr.truncated) parts.push('[output truncated; inspect byte cursors]');
  return { failed: Boolean(failed), texts: [parts.join('\n\n')], data: { stdout, stderr: rawStderr }, execution: result.execution };
}

/** Registry owns authentication, host keys, ProxyJump and profile binding.
 * Only this narrow port knows ssh-mcp/ssh2; the supervisor owns execution. */
async function executeOnChannel(connection, command, options = {}) {
  let client, exactCommand, channelOptions;
  try {
    await connection.ensureConnected();
    client = connection.getClient();
    exactCommand = connection.applyWorkdir(command); channelOptions = connection.channelEnv();
    if (connection.profile.tty) channelOptions.pty = { term: 'xterm-256color', cols: 200, rows: 50 };
  } catch (error) { throw notDispatched(error); }
  return superviseExecution({
    open: (value, callback) => client.exec(value, channelOptions, callback),
    onTransportLost(callback) {
      client.once('close', callback); client.once('error', callback);
      return () => { client.removeListener('close', callback); client.removeListener('error', callback); };
    },
  }, exactCommand, { maxOutputBytes: connection.profile.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, ...options });
}

/** Separate execution port, never approval authority. Reuse the pinned registry
 * and its authenticated connection. After dispatch, errors/exit codes do not prove
 * that no effect occurred and must never trigger a source replay.
 */
async function executeSourcePlan(registry, plan, verify, options = {}, prepare = preparePythonSource, beforeDispatch = async () => {}) {
  if (typeof verify !== 'function' || !plan?.manifest) dispatchRefusal('private_plan', 'source_plan', 'Source target verification required');
  const submitted = plan.manifest;
  const exact = prepare({ source: plan.stdin, argv: JSON.parse(submitted.argvJson), cwd: submitted.cwd, elevate: submitted.elevate,
    targetId: submitted.targetId, targetRevision: submitted.targetRevision, profile: submitted.profile, environmentRevision: submitted.environmentRevision, ...(submitted.platform === 'windows' ? { platform: 'windows', pythonExecutable: submitted.interpreter } : {}) });
  if (exact.command !== plan.command || exact.planDigest !== plan.planDigest
    || exact.transportStdin !== plan.transportStdin
    || JSON.stringify(exact.manifest) !== JSON.stringify(submitted) || JSON.stringify(exact.args) !== JSON.stringify(plan.args)) dispatchRefusal('private_plan', 'source_plan', 'Source execution plan changed');
  const m = exact.manifest;
  const check = () => {
    let binding;
    try { binding = verify(); } catch (error) { throw notDispatched(error); }
    if (!binding || binding.targetId !== m.targetId || binding.targetRevision !== m.targetRevision || binding.profile !== m.profile) dispatchRefusal('target_changed', 'target_guard', 'Source target binding changed');
  };
  check();
  let connection;
  try { connection = await acquireSshConnection(registry, m.profile); } catch (error) { throw notDispatched(error); }
  check();
  if (connection.profile.tty === true || connection.profile.readOnly !== false) dispatchRefusal('private_plan', 'source_plan', 'Source execution requires a writable non-TTY profile');
  if (connection.profile.workdir) dispatchRefusal('private_plan', 'source_plan', 'Source execution requires an explicit cwd without profile workdir');
  if (JSON.stringify(connection.profile) !== JSON.stringify(registry.getProfile(m.profile))) dispatchRefusal('target_changed', 'target_guard', 'Source SSH profile changed');
  const profileSnapshot = JSON.stringify(connection.profile);
  const execute = observed => {
    const guarded = new Proxy(withDispatchGuard(observed, beforeDispatch), { get(target, key) {
      if (key === 'getClient') return () => {
        check();
        if (JSON.stringify(target.profile) !== profileSnapshot || JSON.stringify(registry.getProfile(m.profile)) !== profileSnapshot) dispatchRefusal('target_changed', 'target_guard', 'Source SSH profile changed');
        return target.getClient();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return executeOnChannel(guarded, exact.command, { stdin: exact.transportStdin ?? exact.stdin, ...options });
  };
  try { return await withConnectionLifecycle(connection, execute); }
  catch (error) {
    if (isDispatchRefusal(error) || executionFailureDetails(error, false)?.remoteOutcome === 'not_started') throw error;
    const failure = executionFailure(error, { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED' });
    failure.message = 'Source execution result unknown; do not retry automatically'; throw failure;
  }
}

export async function executePythonSource(registry, plan, verify, beforeDispatch = async () => {}, options = {}) {
  validateExecutionOptions(options);
  return commandOutcome(await executeSourcePlan(registry, plan, verify, options, preparePythonSource, beforeDispatch));
}

/** Fixed CLI helper only; not a generic raw-output or arbitrary-timeout escape hatch. */
export async function executeAgentCli(registry, plan, verify, beforeDispatch = async () => {}, options = {}) {
  validateExecutionOptions(options);
  const exact = validateAgentCliPlan(plan);
  const timeoutMs = ['install','update'].includes(exact.agentCli.action) ? 930000 : 30000;
  let result;
  const prepare = exact.manifest.contract === 'agent-cli-powershell-v1' ? () => validateAgentCliPlan(exact) : preparePythonHelper;
  try { result = await executeSourcePlan(registry, exact, verify, { ...options, timeoutMs }, prepare, beforeDispatch); }
  catch (error) {
    if (isDispatchRefusal(error) || executionFailureDetails(error, false)?.remoteOutcome === 'not_started') throw error;
    const failure = executionFailure(error, { stage: 'ssh_execution', code: 'SSH_EXECUTION_FAILED' });
    failure.message = 'CLI result unknown; inspect saved status, never retry automatically'; throw failure;
  }
  if (result.execution.reason !== 'exit' || result.execution.remoteState !== 'exited') return { failed: true, texts: ['CLI result unknown; inspect saved status, never retry automatically'], execution: result.execution };
  return { ...projectAgentCliResult(result, exact), execution: result.execution };
}

/** The only adapter coupled to ssh-mcp's versioned internal modules. */
export async function createSshRuntime(settings) {
  if (createRequire(import.meta.url)('ssh-mcp/package.json').version !== '2.18.0') throw Error('Requires ssh-mcp 2.18.0');
  for (const [key, value] of Object.entries(settings)) if (key.startsWith('SSH_MCP_')) process.env[key] = value;
  const config = await loadConfig(settings.BRIDGE_CONFIG_PATH);
  const registry = new ConnectionRegistry(config, settings.BRIDGE_HOST_KEY_MODE ?? 'tofu');
  const auditRedact = defaultRedact;
  const timeoutMs = Number(settings.BRIDGE_COMMAND_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error('Invalid BRIDGE_COMMAND_TIMEOUT_MS');
  return {
    registry, classify: classifyCommand, auditRedact,
    async executeCommand(profile, command, beforeDispatch = async () => {}, options = {}) {
      validateExecutionOptions(options, true);
      const binding = await connectionBinding(registry, profile);
      const result = await withConnectionLifecycle(binding.connection, observed => executeOnChannel(withDispatchGuard(observed, beforeDispatch, binding.verify), command, { timeoutMs, ...options }));
      return commandOutcome(result, auditRedact);
    },
    executePythonSource: (plan, verify, beforeDispatch, options = {}) => executePythonSource(registry, plan, verify, beforeDispatch, { timeoutMs, ...options }),
    executeAgentCli: (plan, verify, beforeDispatch, options) => executeAgentCli(registry, plan, verify, beforeDispatch, options),
    openDesktopChannel: (profile, options) => openSshForward(registry, profile, options),
  };
}

/** Open only the configured host's loopback service. Closing the returned lease
 * never ends the shared authenticated SSH transport or another channel. */
export async function openSshForward(registry, profile, { host, port, beforeDispatch = async () => {}, signal, timeoutMs = 30_000 } = {}) {
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error('Invalid desktop channel endpoint');
  if (signal?.aborted) throw Error('Desktop channel cancelled before dispatch');
  const binding = await connectionBinding(registry, profile);
  return withConnectionLifecycle(binding.connection, async observed => {
    const guarded = withDispatchGuard(observed, beforeDispatch, binding.verify);
    await guarded.ensureConnected();
    if (signal?.aborted) throw Error('Desktop channel cancelled before dispatch');
    const client = guarded.getClient();
    return new Promise((resolve, reject) => {
      let done = false, stream;
      const close = () => { if (stream && !stream.destroyed) stream.destroy(); };
      const cleanOpening = () => { clearTimeout(timer); client.removeListener('close', onLost); client.removeListener('error', onLost); };
      const fail = error => {
        if (done) { close(); return; }
        done = true; cleanOpening(); signal?.removeEventListener('abort', onAbort); close(); reject(error);
      };
      const onLost = () => fail(Error('Desktop SSH transport lost'));
      const onAbort = () => fail(Error('Desktop channel cancelled'));
      const timer = setTimeout(() => fail(Error('Desktop channel opening timed out')), timeoutMs);
      client.once('close', onLost); client.once('error', onLost); signal?.addEventListener('abort', onAbort, { once: true });
      try {
        client.forwardOut('127.0.0.1', 0, host, port, (error, opened) => {
          if (error) { fail(error); return; }
          stream = opened;
          if (done || signal?.aborted) { close(); if (!done) fail(Error('Desktop channel cancelled')); return; }
          done = true; cleanOpening();
          stream.once('close', () => signal?.removeEventListener('abort', onAbort));
          resolve({ stream, close });
        });
      } catch (error) { fail(error); }
    });
  });
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
      let originalClient, originalConnection, originalVerify, unconfirmedOpens = 0;
      const clientView = (client, current) => new Proxy(client, { get(target, key) {
        if (key === 'exec' || key === 'sftp') return (...args) => {
          const callback = args.pop();
          unconfirmedOpens++;
          return target[key](...args, (error, channel) => {
            if (!error || error.reason !== undefined) unconfirmedOpens--;
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
            if (unconfirmedOpens) throw Error('Remote staging outcome unconfirmed');
            return Promise.resolve({ exitCode: 0, stdout: '{"cleaned":true}' });
          }
          verifyCleanup();
          return withConnectionLifecycle(originalConnection, observed => executeOnChannel(withDispatchGuard(observed, cleanupGuard, originalVerify, { connectedOnly: true }), cleanupCommand, { stdin: cleanupInput, timeoutMs: idleTimeoutMs }));
        } }),
        call(command, payload) { return perform(connection => executeOnChannel(connection, command, { stdin: JSON.stringify(payload), ...(idleTimeoutMs === undefined ? {} : { timeoutMs: idleTimeoutMs }) })); },
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
