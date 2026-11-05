const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const fields = ['event', 'id', 'state', 'targetId', 'targetRevision', 'finishedAt', 'failed', 'auditFailure',
  'failureCode', 'exitCode', 'reason', 'remoteOutcome', 'outputState'];

/** The shared notification boundary: only these 13 status fields may leave the watcher. */
export function projectCompletionEvent(event) {
  try {
    // Snapshot once: getters must not change a validated scalar before serialization.
    event = Object.fromEntries(fields.map(key => [key, event[key]]));
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
    return event;
  } catch { throw Object.assign(Error('INVALID_COMPLETION_EVENT'), { code: 'INVALID_COMPLETION_EVENT' }); }
}
