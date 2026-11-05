import { execFile } from 'node:child_process';
import net from 'node:net';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateLocalPath } from './local-files.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/i;
const unavailable = reasonCode => ({ state: 'unavailable', reasonCode });
const unknown = reasonCode => ({ state: 'unknown', reasonCode });
const requested = () => ({ state: 'requested' });
const spawnCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOEXEC', 'EINVAL']);

async function existingExecutable(file) {
  try {
    validateLocalPath(file);
    return !/\.(?:cmd|bat|ps1)$/i.test(file) && (await stat(file)).isFile();
  } catch { return false; }
}

// execFile's timeout bounds the process; our deadline also bounds a missing callback.
function runBounded(run, command, args, environment) {
  return new Promise(resolve => {
    let child, spawned = false, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, spawned });
    };
    const timer = setTimeout(() => {
      finish({ timedOut: true });
      try { child?.kill('SIGKILL'); } catch { /* The outcome remains unknown. */ }
    }, 5000);
    try {
      child = run(command, args, {
        shell: false, windowsHide: true, windowsVerbatimArguments: false,
        encoding: 'utf8', timeout: 5000, maxBuffer: 16384, killSignal: 'SIGKILL', env: environment,
      }, (error, stdout, stderr) => finish({ error, stdout, stderr }));
      child?.once('spawn', () => { spawned = true; });
      child?.once('error', error => finish({ error }));
    } catch (error) { finish({ error, spawnFailed: true }); }
  });
}

function processFailure(result, prefix) {
  if (result.timedOut || result.error?.killed || result.error?.code === 'ETIMEDOUT') return unknown(`${prefix}_TIMEOUT`);
  if (!result.error) return null;
  if (!result.spawned && (result.spawnFailed || spawnCodes.has(result.error.code))) {
    return unavailable(result.error.code === 'ENOENT' ? `${prefix}_EXECUTABLE_MISSING` : `${prefix}_SPAWN_FAILED`);
  }
  return unknown(`${prefix}_EXIT_NONZERO`);
}

async function wakeCodex({ executable, environment, sessionId, marker, run }) {
  let command = executable, argsPrefix = [];
  if (executable === undefined) {
    const root = environment.CODEX_MANAGED_PACKAGE_ROOT;
    try { validateLocalPath(root); } catch { return unavailable('CODEX_EXECUTABLE_MISSING'); }
    const launcher = join(root, 'bin', 'codex.js');
    if (!(await existingExecutable(launcher))) return unavailable('CODEX_NPM_LAUNCHER_MISSING');
    command = process.execPath;
    argsPrefix = [launcher];
  } else if (!(await existingExecutable(command))) return unavailable('CODEX_EXECUTABLE_MISSING');
  const result = await runBounded(run, command, [...argsPrefix, 'queue', '--thread', sessionId, '--message', marker], environment);
  // This documented rejection confirms no queue effect. Other spawned failures may have queued.
  if (result.error && !result.timedOut && !result.error.killed &&
      typeof result.stderr === 'string' && result.stderr.includes('No active session found')) {
    return unavailable('CODEX_NO_ACTIVE_SESSION');
  }
  return processFailure(result, 'CODEX_QUEUE') ?? requested();
}

function wakeClaude({ environment, marker, connect }) {
  const socketPath = environment.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = environment.CLAUDE_CODE_MESSAGING_TOKEN;
  if (typeof socketPath !== 'string' || !socketPath || typeof token !== 'string' || !token) {
    return unavailable('CLAUDE_MESSAGING_ENV_MISSING');
  }
  return new Promise(resolve => {
    let socket, connected = false, wrote = false, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      try { socket?.destroy(); } catch { /* The outcome is already fixed. */ }
    };
    const failure = () => connected || wrote ? unknown('CLAUDE_INBOX_WRITE_UNCONFIRMED') : unavailable('CLAUDE_INBOX_CONNECT_FAILED');
    const timer = setTimeout(() => finish(unknown('CLAUDE_INBOX_TIMEOUT')), 5000);
    try {
      socket = connect(socketPath);
      socket.once('error', () => finish(failure()));
      socket.once('close', hadError => finish(!hadError && wrote ? requested() : failure()));
      socket.once('connect', () => {
        if (settled) return;
        connected = true;
        try {
          wrote = true;
          socket.end(`${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({
            type: 'user', message: { role: 'user', content: marker }, priority: 'next',
          })}\n`);
        } catch { finish(unknown('CLAUDE_INBOX_WRITE_UNCONFIRMED')); }
      });
    } catch { finish(unavailable('CLAUDE_INBOX_CONNECT_FAILED')); }
  });
}

async function wakeAntigravity({ environment, sessionId, marker, run }) {
  const projectId = environment.ANTIGRAVITY_PROJECT_ID;
  if (typeof projectId !== 'string' || !projectId.trim()) return unavailable('ANTIGRAVITY_PROJECT_ID_MISSING');
  const command = environment.ANTIGRAVITY_AGENTAPI_EXE;
  if (!(await existingExecutable(command))) return unavailable('ANTIGRAVITY_AGENTAPI_UNAVAILABLE');
  if (!environment.ANTIGRAVITY_LS_ADDRESS || !environment.ANTIGRAVITY_CSRF_TOKEN) {
    return unavailable('ANTIGRAVITY_LS_CONNECTION_MISSING');
  }
  const metadata = await runBounded(run, command, ['agentapi', 'get-conversation-metadata', sessionId], environment);
  const failure = processFailure(metadata, 'ANTIGRAVITY_METADATA');
  // Never send after a failed lookup; retain the uncertain subprocess outcome.
  if (failure) return failure;
  let targetProject;
  try {
    targetProject = JSON.parse(metadata.stdout).response?.conversationMetadata?.metadata?.projectId;
  } catch { return unavailable('ANTIGRAVITY_METADATA_INVALID'); }
  if (typeof targetProject !== 'string' || !targetProject.trim()) return unavailable('ANTIGRAVITY_METADATA_PROJECT_MISSING');
  if (projectId !== targetProject) return unavailable('ANTIGRAVITY_PROJECT_MISMATCH');
  const result = await runBounded(run, command, ['agentapi', 'send-message', sessionId, marker], environment);
  return processFailure(result, 'ANTIGRAVITY_SEND') ?? requested();
}

/** Send only an opaque marker after inbox commit. Never retries; requested is not host/model receipt. */
export async function wakeCompletion({ host, sessionId, receiptId, executable, environment = process.env, run = execFile, connect = net.createConnection }) {
  if (typeof sessionId !== 'string' || !uuid.test(sessionId) || typeof receiptId !== 'string' || !uuid.test(receiptId)) {
    return unavailable('INVALID_WAKE_TARGET');
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return unavailable('INVALID_WAKE_ENVIRONMENT');
  const input = { sessionId, marker: `[ssh-mcp:completion:${receiptId}]`, executable, environment: { ...environment }, run, connect };
  if (host === 'codex') return wakeCodex(input);
  if (host === 'claude-code') return wakeClaude(input);
  if (host === 'antigravity' || host === 'agy') return wakeAntigravity(input);
  return unavailable('HOST_WAKE_UNSUPPORTED');
}
