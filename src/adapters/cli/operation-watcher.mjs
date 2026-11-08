import { createOwnerHttpSession, readPortalJson } from './owner-http-session.mjs';
import { opaqueOperationKeyValid } from './opaque-files-client.mjs';

const states = new Set(['accepted', 'pending', 'evaluating', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}(?![\s\S])/.test(id);
const validTarget = target => typeof target === 'string' && /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(target);
const validRevision = revision => typeof revision === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(revision);
const fail = (code, requestId) => Object.assign(Error(code), { code, ...(validId(requestId) ? { requestId } : {}) });

/** Run in the host's background process facility. Only this process waits;
 * it never submits, approves, cancels or replays the remote operation. */
export function createOperationWatcher(options) {
  const session = createOwnerHttpSession({ timeoutMs: 600_000, ...options });
  const controller = new AbortController();
  let active = false, closed = false;
  return {
    connect: session.connect,
    async watch(selector) {
      const objectSelector = selector !== null && typeof selector === 'object' && !Array.isArray(selector);
      const byKey = objectSelector && selector.operationKey !== undefined;
      const operationKey = byKey ? selector.operationKey : undefined;
      let id = objectSelector ? selector.id : selector;
      if (objectSelector) {
        if (Object.keys(selector).some(key => !['id', 'operationKey', 'target', 'expectedTargetRevision'].includes(key)) ||
            (byKey ? id !== undefined || !opaqueOperationKeyValid(operationKey) : !validId(id))) throw fail('INVALID_OPERATION_SELECTOR');
        if ((selector.target !== undefined || selector.expectedTargetRevision !== undefined) &&
            (!validTarget(selector.target) || !validRevision(selector.expectedTargetRevision))) throw fail('INVALID_OPERATION_BINDING');
      } else if (!validId(id)) throw fail('INVALID_REQUEST_ID');
      if (closed) throw fail('WATCH_STOPPED', id);
      if (active) throw fail('WATCH_ALREADY_ACTIVE', id);
      session.ready(); active = true;
      let binding;
      try {
        while (!closed) {
          const path = byKey ? '/api/operations/by-key?operationKey=' + encodeURIComponent(operationKey) + '&waitMs=25000'
            : '/api/' + id + '?observe=1&waitMs=25000';
          const response = await session.request(path, { signal: controller.signal });
          const value = await readPortalJson(response), data = value?.data;
          if (value?.contractVersion !== '2.0' || value.ok !== true || value.error !== null || !data || !validId(data.id) || (id !== undefined && data.id !== id) || !states.has(data.state) ||
              !validTarget(data.targetId) || !validRevision(data.targetRevision) ||
              (byKey && data.operationKey !== operationKey) ||
              (data.failed !== null && typeof data.failed !== 'boolean') || typeof data.auditFailure !== 'boolean' ||
              (data.finishedAt !== null && (!Number.isSafeInteger(data.finishedAt) || data.finishedAt < 0))) throw fail('INVALID_OPERATION_RESPONSE', id);
          id ??= data.id;
          if (objectSelector && selector.target !== undefined && (data.targetId !== selector.target || data.targetRevision !== selector.expectedTargetRevision)) throw fail('OPERATION_BINDING_CONFLICT', id);
          const current = JSON.stringify([data.operationKey ?? null, data.targetId, data.targetRevision]);
          if (binding !== undefined && binding !== current) throw fail('OPERATION_BINDING_CONFLICT', id);
          binding = current;
          if (!terminal.has(data.state)) continue;
          const execution = data.execution;
          if (execution !== null && (!execution || (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) ||
              ![null, 'exit', 'deadline', 'cancel', 'transport_lost', 'channel_open_failed', 'input_failed'].includes(execution.reason))) throw fail('INVALID_OPERATION_RESPONSE', id);
          if (![null, 'not_started', 'completed', 'unknown'].includes(data.remoteOutcome) ||
              (data.failureCode !== null && (typeof data.failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}(?![\s\S])/.test(data.failureCode))) ||
              (data.output !== null && (!data.output || !['pending', 'ready', 'unavailable', 'expired'].includes(data.output.state)))) throw fail('INVALID_OPERATION_RESPONSE', id);
          return { event: 'operation.finished', id, ...(byKey ? { operationKey } : {}), state: data.state, targetId: data.targetId, targetRevision: data.targetRevision,
            finishedAt: data.finishedAt, failed: data.failed, auditFailure: data.auditFailure, failureCode: data.failureCode,
            exitCode: execution?.exitCode ?? null, reason: execution?.reason ?? null,
            remoteOutcome: data.remoteOutcome, outputState: data.output?.state ?? null };
        }
        throw fail('WATCH_STOPPED', id);
      } catch (error) {
        if (controller.signal.aborted) throw fail('WATCH_STOPPED', id);
        if (session.signal.aborted) throw fail(options?.signal?.aborted ? 'WATCH_STOPPED' : 'WATCH_TIMEOUT', id);
        // The watcher endpoint has a closed refusal vocabulary. Do not expose arbitrary server text.
        if (!['OPERATION_NOT_FOUND', 'TARGET_REVISION_CONFLICT', 'OPERATION_OBSERVER_CAPACITY', 'OPERATION_OBSERVATION_FAILED', 'INVALID_OPERATION_OBSERVER'].includes(error.serverCode)) delete error.serverCode;
        throw Object.assign(error, { ...(validId(id) ? { requestId: id } : {}), ...(byKey ? { operationKey } : {}) });
      } finally { active = false; }
    },
    async close() { closed = true; controller.abort(); await session.close(); },
  };
}
