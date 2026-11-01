import { performance } from 'node:perf_hooks';

const messages = Object.freeze({
  REQUEST_QUEUE_FULL: 'Request queue is full',
  REQUEST_QUEUE_TIMEOUT: 'Request queue wait timed out',
  REQUEST_QUEUE_CLOSED: 'Request queue is closed',
  REQUEST_ABORTED: 'Request was aborted',
  REQUEST_WAIT_LIMIT: 'Long-running request limit reached',
});

export class RequestAdmissionError extends Error {
  constructor(code) {
    if (!Object.hasOwn(messages, code)) throw new TypeError('Invalid request admission error code');
    super(messages[code]);
    this.name = 'RequestAdmissionError';
    this.code = code;
  }
}

/** Process-local admission only; the lease owner releases actual work. */
export function createRequestAdmission({ maxActive = 8, maxQueued = 32, maxWaitMs = 5000, maxDetached = 64 } = {}) {
  if (!Number.isSafeInteger(maxActive) || maxActive < 1
    || !Number.isSafeInteger(maxQueued) || maxQueued < 0
    || !Number.isSafeInteger(maxDetached) || maxDetached < 0
    || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 2_147_483_647) {
    throw new RangeError('Invalid request admission limits');
  }
  let active = 0, detached = 0, closed = false;
  // ponytail: bounded array FIFO; change representation only if queue limits grow materially.
  const queue = [];

  function lease() {
    active++;
    let state = 'active';
    return {
      release() {
        if (state === 'released') return;
        if (state === 'active') active--;
        else detached--;
        state = 'released';
        drain();
      },
      detach() {
        if (state !== 'active') return;
        if (closed) throw new RequestAdmissionError('REQUEST_QUEUE_CLOSED');
        if (detached >= maxDetached) throw new RequestAdmissionError('REQUEST_WAIT_LIMIT');
        // Reserve the detached slot before freeing admission to another request.
        detached++;
        state = 'detached';
        active--;
        drain();
      },
    };
  }

  function remove(entry) {
    if (!entry.pending) return false;
    entry.pending = false;
    queue.splice(queue.indexOf(entry), 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    return true;
  }

  function reject(entry, code) {
    if (remove(entry)) entry.reject(new RequestAdmissionError(code));
  }

  function drain() {
    while (!closed && active < maxActive && queue.length) {
      const entry = queue[0];
      if (entry.signal?.aborted) reject(entry, 'REQUEST_ABORTED');
      else if (performance.now() >= entry.deadline) reject(entry, 'REQUEST_QUEUE_TIMEOUT');
      else {
        remove(entry);
        entry.resolve(lease());
      }
    }
  }

  return {
    async acquire({ signal } = {}) {
      if (closed) throw new RequestAdmissionError('REQUEST_QUEUE_CLOSED');
      if (signal?.aborted) throw new RequestAdmissionError('REQUEST_ABORTED');
      drain();
      if (active < maxActive && queue.length === 0) return lease();
      if (queue.length >= maxQueued) throw new RequestAdmissionError('REQUEST_QUEUE_FULL');
      return new Promise((resolve, rejectPromise) => {
        const entry = { resolve, reject: rejectPromise, signal, deadline: performance.now() + maxWaitMs, pending: true };
        entry.abort = () => reject(entry, 'REQUEST_ABORTED');
        queue.push(entry);
        entry.timer = setTimeout(() => reject(entry, 'REQUEST_QUEUE_TIMEOUT'), maxWaitMs);
        signal?.addEventListener('abort', entry.abort, { once: true });
        // A cancellation which precedes listener registration must also settle once.
        if (signal?.aborted) entry.abort();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of [...queue]) reject(entry, 'REQUEST_QUEUE_CLOSED');
    },
    snapshot() {
      return { active, queued: queue.length, detached, closed, maxActive, maxQueued, maxDetached, maxWaitMs };
    },
  };
}
