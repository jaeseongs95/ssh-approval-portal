import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createOpaqueFilesClient, opaqueUuidValid, opaqueOperationKeyValid } from '../src/adapters/cli/opaque-files-client.mjs';
import { resolveCloudflared, cachedAccessToken } from '../src/adapters/cli/cloudflared.mjs';
import { diagnoseClient } from '../src/adapters/cli/doctor.mjs';
import { validateLocalPath } from '../src/adapters/cli/local-files.mjs';
import { validateOrigin } from '../src/adapters/config/settings.mjs';
import { safePortalErrorCode } from '../src/adapters/cli/owner-http-session.mjs';
import { createOperationWatcher } from '../src/adapters/cli/operation-watcher.mjs';
import { notifyCodexCompletion, validateCodexCompletionTarget } from '../src/adapters/cli/codex-completion.mjs';
import { validateCompletionDeliveryTarget, deliverCompletion } from '../src/adapters/cli/completion-delivery.mjs';

const usage = 'SSH Approval Portal file client2.3.2 (Node.js24.2+ within major24)\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] doctor\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] upload --file ABSOLUTE_FILE --operation-key STABLE_KEY\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] status UUID\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] watch REQUEST_ID [--timeout-ms 600000] [--notify-codex ABSOLUTE_EXECUTABLE --thread EXACT_SESSION_UUID]\n' +
  'node scripts/portal-files.mjs --origin HTTPS_ORIGIN [--cloudflared EXISTING_ABSOLUTE_PATH] watch REQUEST_ID --notify-hook --host codex|claude-code|antigravity --session EXACT_SESSION_ID [--inbox ABSOLUTE_DB] [--wake-executable ABSOLUTE_EXECUTABLE]\n' +
  'Verify the completion plugin is loaded in your own session; installed/registered is not proof of hook execution. Hook notification requires a binding registered by that session hook. Metadata is committed before wake; a wake request does not confirm host/model receipt. Hook and direct Codex notification options cannot be combined.\n' +
  'Background watch, continue independent work, then consume its hook body. Handle the same operation ID and run the supplied portal-completion-hook ack command with its exact host/session/receipt/claim. Never ACK a wake marker without a body. Stopping watch never cancels or replays SSH. No automatic host wake is guaranteed without host support.\n' +
  'Upload sends PC bytes directly over owner-authenticated HTTP. Success stdout is only {"uuid":"..."}. No automatic login, install, retry, approval or SSH destination selection.\n';

export async function main(argv = process.argv.slice(2), output = process.stdout, errorOutput = process.stderr,
  runCredential = execFileSync, environment = process.env, openClient = createOpaqueFilesClient, diagnose = diagnoseClient, openWatcher = createOperationWatcher, notify = notifyCodexCompletion, deliveryServices = {}) {
  let client, result, command, requestId, completionTarget, failed = false, notificationFailed = false;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: 'boolean' }, origin: { type: 'string' }, cloudflared: { type: 'string' }, file: { type: 'string' }, 'operation-key': { type: 'string' }, 'timeout-ms': { type: 'string' },
      'notify-codex': { type: 'string' }, thread: { type: 'string' },
      'notify-hook': { type: 'boolean' }, host: { type: 'string' }, session: { type: 'string' },
      inbox: { type: 'string' }, 'wake-executable': { type: 'string' },
    } });
    if (values.help === true && argv.length === 1) { output.write(usage); return 0; }
    command = positionals[0];
    if (command === 'watch') requestId = positionals[1];
    if (values.help || !values.origin || !['doctor', 'upload', 'status', 'watch'].includes(command) ||
        positionals.length !== (['status', 'watch'].includes(command) ? 2 : 1) ||
        (command === 'upload' ? !values.file || !values['operation-key'] : values.file !== undefined || values['operation-key'] !== undefined)) throw Object.assign(Error(), { code: 'INVALID_ARGUMENTS' });
    validateOrigin(values.origin);
    if (values['timeout-ms'] !== undefined && (command !== 'watch' || !/^[1-9][0-9]{0,5}(?![\s\S])/.test(values['timeout-ms']) || Number(values['timeout-ms']) > 600000))
      throw Object.assign(Error(), { code: 'INVALID_DEADLINE' });
    if (command === 'watch' && !/^[a-f0-9]{48}(?![\s\S])/.test(positionals[1])) throw Object.assign(Error(), { code: 'INVALID_REQUEST_ID' });
    const hookOptions = ['notify-hook', 'host', 'session', 'inbox', 'wake-executable'];
    if (hookOptions.some(key => values[key] !== undefined)) {
      if (command !== 'watch' || values['notify-hook'] !== true || !values.host || !values.session ||
          values['notify-codex'] !== undefined || values.thread !== undefined) throw Object.assign(Error(), { code: 'INVALID_COMPLETION_TARGET' });
      completionTarget = validateCompletionDeliveryTarget({ host: values.host, sessionId: values.session,
        inboxPath: values.inbox, executable: values['wake-executable'], environment }, deliveryServices);
    }
    if (values['notify-codex'] !== undefined || values.thread !== undefined) {
      if (command !== 'watch' || !values['notify-codex'] || !values.thread) throw Object.assign(Error(), { code: 'INVALID_COMPLETION_TARGET' });
      await validateCodexCompletionTarget({ executable: values['notify-codex'], threadId: values.thread });
    }
    if (values.cloudflared !== undefined) validateLocalPath(values.cloudflared);
    if (command === 'status' && !opaqueUuidValid(positionals[1])) throw Object.assign(Error(), { code: 'INVALID_ARTIFACT_UUID' });
    if (command === 'upload') {
      validateLocalPath(values.file);
      if (!opaqueOperationKeyValid(values['operation-key'])) throw Object.assign(Error(), { code: 'INVALID_OPERATION_KEY' });
    }
    if (command === 'doctor') {
      result = await diagnose({ origin: values.origin, cloudflared: values.cloudflared, env: environment, runCredential });
      if (result.state === 'ready') result.next = 'Use portal-files upload --file ABSOLUTE_FILE --operation-key STABLE_KEY. Keep the UUID for the existing remote MCP connection. For an operation ID from MCP submit, launch portal-files watch REQUEST_ID through the host background-process facility, continue independent work, and consume its completion. If background completion is unsupported, do not claim automatic host resumption. Preserve IDs and keys after unknown outcomes; never create replacements.';
      output.write(JSON.stringify(result) + '\n');
      return result.state === 'ready' ? 0 : 1;
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 2) throw Object.assign(Error(), { code: 'UNSUPPORTED_NODE_VERSION' });
    const helper = await resolveCloudflared({ explicit: values.cloudflared, env: environment });
    const token = cachedAccessToken(helper.path, values.origin, runCredential);
    client = command === 'watch' ? openWatcher({ origin: values.origin, accessToken: token, timeoutMs: Number(values['timeout-ms'] ?? 600000) })
      : openClient({ origin: values.origin, accessToken: token });
    await client.connect();
    if (command === 'watch') {
      errorOutput.write(JSON.stringify({ event: 'operation.watch.started', id: positionals[1], timeoutMs: Number(values['timeout-ms'] ?? 600000) }) + '\n');
      result = await client.watch(positionals[1]);
      if (completionTarget) {
        try {
          const notification = await deliverCompletion({ target: completionTarget, origin: values.origin, event: result, environment }, deliveryServices);
          notificationFailed = !['requested', 'deferred'].includes(notification.wake.state);
          result = { ...result, notification };
          if (notificationFailed) errorOutput.write(JSON.stringify({ error: 'COMPLETION_WAKE_UNCONFIRMED', requestId,
            receiptId: notification.receiptId, wakeState: notification.wake.state }) + '\n');
        } catch (error) {
          notificationFailed = true;
          result = { ...result, notification: { state: 'unknown', automaticRetry: false } };
          const code = /^[A-Z_]{3,64}$/.test(error.code ?? '') ? error.code : 'COMPLETION_NOTIFICATION_FAILED';
          errorOutput.write(JSON.stringify({ error: code, requestId }) + '\n');
        }
      }
      if (values['notify-codex']) {
        try { result = { ...result, notification: await notify({ executable: values['notify-codex'], threadId: values.thread, event: result }) }; }
        catch {
          notificationFailed = true;
          result = { ...result, notification: { state: 'unknown', automaticRetry: false } };
          errorOutput.write(JSON.stringify({ error: 'COMPLETION_NOTIFICATION_FAILED', requestId }) + '\n');
        }
      }
    } else result = command === 'status' ? await client.status(positionals[1]) : await client.upload(values.file, values['operation-key'],
      progress => errorOutput.write(JSON.stringify({ uuid: progress.uuid, phase: 'staging' }) + '\n'));
    if (command === 'upload' && (!result || !opaqueUuidValid(result.uuid) || Object.keys(result).length !== 1)) throw Object.assign(Error(), { code: 'INVALID_ARTIFACT_RESPONSE' });
  } catch (error) {
    failed = true;
    const record = { error: /^[A-Z_]{3,64}$/.test(error.code ?? '') ? error.code : 'CLI_REQUEST_FAILED' };
    if (safePortalErrorCode(error.serverCode)) record.serverCode = error.serverCode;
    if (command === 'watch' && typeof requestId === 'string' && /^[a-f0-9]{48}(?![\s\S])/.test(requestId)) record.requestId = requestId;
    if (opaqueUuidValid(error.uuid)) record.uuid = error.uuid;
    if (['snapshot', 'begin', 'chunks', 'complete'].includes(error.phase)) record.phase = error.phase;
    if (error.progress) for (const field of ['state', 'received', 'sequence']) record[field] = error.progress[field];
    errorOutput.write(JSON.stringify(record) + '\n');
  } finally {
    try { await client?.close(); }
    catch { errorOutput.write(JSON.stringify({ error: 'OWNER_SESSION_CLEANUP_UNKNOWN', ...(opaqueUuidValid(result?.uuid) ? { uuid: result.uuid } : {}) }) + '\n'); }
  }
  if (failed) return 1;
  output.write(JSON.stringify(result) + '\n');
  if (command === 'watch') return !notificationFailed && result.state === 'completed' && result.failed !== true && !result.auditFailure ? 0 : 1;
  return 0;
}

const invoked = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (invoked && pathToFileURL(invoked).href === import.meta.url) process.exitCode = await main();
