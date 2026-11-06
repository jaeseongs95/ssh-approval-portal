import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runCompletionHook, acknowledgeCompletion, waitForCompletionHook, completionWaitTimeoutMs } from '../src/adapters/cli/completion-hook.mjs';
import { autoWatchCompletion } from '../src/adapters/cli/completion-auto-watch.mjs';

const usage = 'portal-completion-hook [ack] --host codex|claude-code|antigravity [--inbox ABSOLUTE_DB]\n' +
  'Hooks read native JSON from stdin. ack additionally requires --session SESSION --receipt UUID --claim UUID.\n' +
  'Claude asyncRewake hooks use --wait [--wait-timeout-ms 86340000]; pending metadata goes to stderr with exit2. Waiting is bounded to less than24 hours.\n';
const fail = code => Object.assign(Error(code), { code });

async function readInput(input) {
  let bytes = 0; const chunks = [];
  for await (const chunk of input) {
    const data = Buffer.from(chunk); bytes += data.length;
    // A tool hook can include file content. Bound memory without reading any transcript or tool fields.
    if (bytes > 8 * 1024 * 1024) throw fail('COMPLETION_HOOK_INPUT_TOO_LARGE');
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('COMPLETION_HOOK_INVALID_JSON'); }
}

export async function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  environment = process.env, services = {}) {
  let ack = false, wait = false;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: 'boolean' }, host: { type: 'string' }, inbox: { type: 'string' }, session: { type: 'string' }, event: { type: 'string' },
      receipt: { type: 'string' }, claim: { type: 'string' },
      wait: { type: 'boolean' }, 'wait-timeout-ms': { type: 'string' }, 'watch-config': { type: 'string' },
    } });
    if (values.help && argv.length === 1) { output.write(usage); return 0; }
    ack = positionals[0] === 'ack';
    wait = values.wait === true;
    if (values.help || !values.host || positionals.length !== (ack ? 1 : 0) ||
      (ack ? !values.session || !values.receipt || !values.claim : values.session !== undefined || values.receipt !== undefined || values.claim !== undefined))
      throw fail('COMPLETION_HOOK_INVALID_ARGUMENTS');
    if ((wait && (ack || values.host !== 'claude-code')) ||
        (values['wait-timeout-ms'] !== undefined && (!wait || !/^[1-9][0-9]{0,7}(?![\s\S])/.test(values['wait-timeout-ms']) ||
          Number(values['wait-timeout-ms']) > completionWaitTimeoutMs))) throw fail('COMPLETION_HOOK_INVALID_ARGUMENTS');
    if (values.event !== undefined && (ack || values.host !== 'antigravity' || !['SessionStart', 'PreInvocation', 'PostToolUse', 'PostInvocation', 'Stop'].includes(values.event)))
      throw fail('COMPLETION_HOOK_INVALID_ARGUMENTS');
    const native = ack ? null : await readInput(input);
    if (values.event !== undefined) {
      if (!native || typeof native !== 'object' || Array.isArray(native) || (native.hook_event_name && native.hook_event_name !== values.event))
        throw fail('COMPLETION_HOOK_INVALID_INPUT');
      native.hook_event_name = values.event;
    }
    let hookResult;
    if (!ack) {
      if (!wait) hookResult = runCompletionHook({ host: values.host, input: native, inboxPath: values.inbox, environment }, services);
      try {
        await autoWatchCompletion({ host: values.host, input: native, inboxPath: values.inbox,
          configPath: values['watch-config'], environment }, services);
      } catch (error) {
        const code = /^COMPLETION_[A-Z_]{3,70}$/.test(error?.code ?? '') ? error.code : 'COMPLETION_AUTO_WATCH_FAILED';
        errorOutput.write(JSON.stringify({ error: code, automaticRetry: false }) + '\n');
      }
    }
    if (wait) {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const result = await waitForCompletionHook({ host: values.host, input: native, inboxPath: values.inbox, environment,
          timeoutMs: Number(values['wait-timeout-ms'] ?? completionWaitTimeoutMs), signal: abort.signal }, services);
        if (result.context) { errorOutput.write(result.context + '\n'); return 2; }
        return 0;
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
    const result = ack ? acknowledgeCompletion({ host: values.host, sessionId: values.session, receiptId: values.receipt,
      claimToken: values.claim, inboxPath: values.inbox, environment }, services)
      : hookResult;
    output.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    const code = /^[A-Z_]{3,80}$/.test(error?.code ?? '') ? error.code : 'COMPLETION_HOOK_FAILED';
    errorOutput.write(JSON.stringify({ error: code, automaticRetry: false }) + '\n');
    // A broken notification must not reject the user's command. The persisted record remains unacknowledged.
    if (!ack && !wait) output.write('{}\n');
    return ack ? 1 : 0;
  }
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
