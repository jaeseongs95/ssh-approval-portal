import { join } from 'node:path';
import { validateLocalPath } from './local-files.mjs';
import { openCompletionInbox } from './completion-inbox.mjs';
import { wakeCompletion } from './completion-wake.mjs';

const fail = code => Object.assign(Error(code), { code });
const hosts = new Set(['codex', 'claude-code', 'antigravity', 'generic']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;

export function defaultCompletionInboxPath(environment = process.env) {
  const root = process.platform === 'win32' ? environment.LOCALAPPDATA :
    environment.XDG_STATE_HOME ?? (environment.HOME ? join(environment.HOME, '.local', 'state') : undefined);
  try { validateLocalPath(root); }
  catch { throw fail('COMPLETION_INBOX_INVALID_PATH'); }
  return join(root, 'ssh-mcp-completion', 'completion.sqlite');
}

/** Resolve only a binding already registered by the actual host hook. */
export function validateCompletionDeliveryTarget({ bindingId, host, sessionId, inboxPath, executable, environment = process.env },
  { openInbox = openCompletionInbox } = {}) {
  const byBinding = bindingId !== undefined && host === undefined && sessionId === undefined;
  if (byBinding) {
    if (typeof bindingId !== 'string' || !uuid.test(bindingId)) throw fail('INVALID_COMPLETION_TARGET');
  } else if (bindingId !== undefined || !hosts.has(host) || typeof sessionId !== 'string' || !sessionId.length ||
      Buffer.byteLength(sessionId) > 256 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(sessionId)) {
    throw fail('INVALID_COMPLETION_TARGET');
  }
  inboxPath ??= defaultCompletionInboxPath(environment);
  try {
    validateLocalPath(inboxPath);
    if (executable !== undefined) validateLocalPath(executable);
  } catch { throw fail('INVALID_COMPLETION_TARGET'); }
  const inbox = openInbox({ filePath: inboxPath });
  try {
    const binding = inbox.findBinding(byBinding ? { bindingId } : { host, sessionId });
    if (!binding) throw fail('COMPLETION_BINDING_NOT_FOUND');
    return { bindingId: binding.bindingId, host: binding.host, sessionId: binding.sessionId, inboxPath, executable };
  } finally { inbox.close(); }
}

/** Commit metadata before an optional wake; never ACK or retry on the sender. */
export async function deliverCompletion({ target, origin, event, environment = process.env },
  { openInbox = openCompletionInbox, wake = wakeCompletion } = {}) {
  const inbox = openInbox({ filePath: target.inboxPath });
  let receipt, cleanupFailed = false;
  try { receipt = inbox.enqueue({ bindingId: target.bindingId, origin, event }); }
  finally {
    try { inbox.close(); }
    catch (error) { if (!receipt) throw error; cleanupFailed = true; }
  }
  let wakeResult;
  if (cleanupFailed) wakeResult = { state: 'unknown', reasonCode: 'COMPLETION_INBOX_CLEANUP_UNKNOWN' };
  else if (receipt.state === 'acknowledged') wakeResult = { state: 'deferred', reasonCode: 'COMPLETION_ALREADY_SETTLED' };
  else {
    try {
      wakeResult = await wake({ host: target.host, sessionId: target.sessionId, receiptId: receipt.receiptId,
        executable: target.executable, environment });
    } catch { wakeResult = { state: 'unknown', reasonCode: 'COMPLETION_WAKE_FAILED' }; }
  }
  return { state: 'queued', receiptId: receipt.receiptId, duplicate: receipt.duplicate,
    deliveryState: receipt.state, wake: wakeResult, automaticRetry: false };
}
