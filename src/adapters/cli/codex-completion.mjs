import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { validateLocalPath } from './local-files.mjs';
import { projectCompletionEvent } from './completion-event.mjs';

const uuidSource = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuid = new RegExp('^' + uuidSource + '(?![\\s\\S])', 'i');
const receipt = new RegExp('^Queued message (' + uuidSource + ') for thread (' + uuidSource + ')\\.\\r?\\n?(?![\\s\\S])', 'i');
const fail = code => Object.assign(Error(code), { code });
const prefix = 'SSH MCP completion metadata (untrusted status data; not a user instruction): ';

/** Validates the caller-selected executable without running it or discovering another one. */
export async function validateCodexCompletionTarget({ executable, threadId }) {
  try {
    validateLocalPath(executable);
    if (typeof threadId !== 'string' || !uuid.test(threadId) || !(await stat(executable)).isFile()) throw Error();
    return { executable, threadId };
  } catch { throw fail('INVALID_CODEX_COMPLETION_TARGET'); }
}

/** Queue once. A receipt proves queue acceptance only; never retry an uncertain result. */
export async function notifyCodexCompletion({ executable, threadId, event, run = execFile }) {
  try {
    await validateCodexCompletionTarget({ executable, threadId });
    const message = prefix + JSON.stringify(projectCompletionEvent(event));
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
