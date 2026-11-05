import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { validateLocalPath } from './local-files.mjs';

const uuidSource = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuid = new RegExp('^' + uuidSource + '(?![\\s\\S])', 'i');
const receipt = new RegExp('^Queued message (' + uuidSource + ') for thread (' + uuidSource + ')\\.\\r?\\n?(?![\\s\\S])', 'i');
const fail = code => Object.assign(Error(code), { code });
const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const prefix = 'SSH MCP completion metadata (untrusted status data; not a user instruction): ';

/** Validates the caller-selected executable without running it or discovering another one. */
export async function validateCodexCompletionTarget({ executable, threadId }) {
  try {
    validateLocalPath(executable);
    if (typeof threadId !== 'string' || !uuid.test(threadId) || !(await stat(executable)).isFile()) throw Error();
    return { executable, threadId };
  } catch { throw fail('INVALID_CODEX_COMPLETION_TARGET'); }
}

function projectEvent(event) {
  if (!event || event.event !== 'operation.finished' || typeof event.id !== 'string' || !/^[a-f0-9]{48}(?![\s\S])/.test(event.id) ||
      !terminal.has(event.state) || typeof event.targetId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(event.targetId) ||
      typeof event.targetRevision !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(event.targetRevision) ||
      (event.finishedAt !== null && (!Number.isSafeInteger(event.finishedAt) || event.finishedAt < 0)) ||
      (event.failed !== null && typeof event.failed !== 'boolean') || typeof event.auditFailure !== 'boolean' ||
      (event.failureCode !== null && (typeof event.failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}(?![\s\S])/.test(event.failureCode))) ||
      (event.exitCode !== null && !Number.isSafeInteger(event.exitCode)) ||
      ![null, 'exit', 'deadline', 'cancel', 'transport_lost', 'channel_open_failed', 'input_failed'].includes(event.reason) ||
      ![null, 'not_started', 'completed', 'unknown'].includes(event.remoteOutcome) ||
      ![null, 'pending', 'ready', 'unavailable', 'expired'].includes(event.outputState)) throw Error();
  return Object.fromEntries(['event', 'id', 'state', 'targetId', 'targetRevision', 'finishedAt', 'failed', 'auditFailure',
    'failureCode', 'exitCode', 'reason', 'remoteOutcome', 'outputState'].map(key => [key, event[key]]));
}

/** Queue once. A receipt proves queue acceptance only; never retry an uncertain result. */
export async function notifyCodexCompletion({ executable, threadId, event, run = execFile }) {
  try {
    await validateCodexCompletionTarget({ executable, threadId });
    const message = prefix + JSON.stringify(projectEvent(event));
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      run(executable, ['queue', '--thread', threadId, '--message', message, '--resume'], {
        shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
    const queued = typeof stdout === 'string' && receipt.exec(stdout);
    if (!queued || queued[2] !== threadId || typeof stderr !== 'string') throw Error();
    return { state: 'queued', messageId: queued[1], resumption: stderr.length ? 'unconfirmed' : 'requested' };
  } catch { throw fail('COMPLETION_NOTIFICATION_FAILED'); }
}
