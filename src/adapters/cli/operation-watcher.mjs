import { createOwnerHttpSession, readPortalJson } from './owner-http-session.mjs';

const states = new Set(['accepted', 'pending', 'evaluating', 'queued', 'starting', 'running', 'terminating', 'completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}(?![\s\S])/.test(id);
const fail = (code, requestId) => Object.assign(Error(code), { code, ...(validId(requestId) ? { requestId } : {}) });

/** Run in the host's background process facility. Only this process waits;
 * it never submits, approves, cancels or replays the remote operation. */
export function createOperationWatcher(options) {
  const session = createOwnerHttpSession({ timeoutMs: 600_000, ...options });
  const controller = new AbortController();
  let active = false, closed = false;
  return {
    connect: session.connect,
    async watch(id) {
      if (!validId(id)) throw fail('INVALID_REQUEST_ID');
      if (closed) throw fail('WATCH_STOPPED', id);
      if (active) throw fail('WATCH_ALREADY_ACTIVE', id);
      session.ready(); active = true;
      let binding;
      try {
        while (!closed) {
          const response = await session.request('/api/' + id + '?observe=1&waitMs=25000', { signal: controller.signal });
          const value = await readPortalJson(response), data = value?.data;
          if (value?.contractVersion !== '2.0' || value.ok !== true || value.error !== null || !data || data.id !== id || !states.has(data.state) ||
              typeof data.targetId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(data.targetId) ||
              typeof data.targetRevision !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(data.targetRevision) ||
              (data.failed !== null && typeof data.failed !== 'boolean') || typeof data.auditFailure !== 'boolean' ||
              (data.finishedAt !== null && (!Number.isSafeInteger(data.finishedAt) || data.finishedAt < 0))) throw fail('INVALID_OPERATION_RESPONSE', id);
          const current = data.targetId + ':' + data.targetRevision;
          if (binding !== undefined && binding !== current) throw fail('OPERATION_BINDING_CONFLICT', id);
          binding = current;
          if (!terminal.has(data.state)) continue;
          const execution = data.execution;
          if (execution !== null && (!execution || (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode)) ||
              ![null, 'exit', 'deadline', 'cancel', 'transport_lost', 'channel_open_failed', 'input_failed'].includes(execution.reason))) throw fail('INVALID_OPERATION_RESPONSE', id);
          if (![null, 'not_started', 'completed', 'unknown'].includes(data.remoteOutcome) ||
              (data.failureCode !== null && (typeof data.failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}(?![\s\S])/.test(data.failureCode))) ||
              (data.output !== null && (!data.output || !['pending', 'ready', 'unavailable', 'expired'].includes(data.output.state)))) throw fail('INVALID_OPERATION_RESPONSE', id);
          return { event: 'operation.finished', id, state: data.state, targetId: data.targetId, targetRevision: data.targetRevision,
            finishedAt: data.finishedAt, failed: data.failed, auditFailure: data.auditFailure, failureCode: data.failureCode,
            exitCode: execution?.exitCode ?? null, reason: execution?.reason ?? null,
            remoteOutcome: data.remoteOutcome, outputState: data.output?.state ?? null };
        }
        throw fail('WATCH_STOPPED', id);
      } catch (error) {
        if (controller.signal.aborted) throw fail('WATCH_STOPPED', id);
        if (session.signal.aborted) throw fail(options?.signal?.aborted ? 'WATCH_STOPPED' : 'WATCH_TIMEOUT', id);
        throw Object.assign(error, { requestId: id });
      } finally { active = false; }
    },
    async close() { closed = true; controller.abort(); await session.close(); },
  };
}
