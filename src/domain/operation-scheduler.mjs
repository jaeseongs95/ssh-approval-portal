const terminal = new Set(['completed', 'failed', 'cancelled', 'expired', 'denied', 'unknown']);
const activeStates = ['starting', 'running', 'terminating'];
const error = code => Object.assign(Error(code), { code, accepted: false, retryable: ['OPERATION_QUEUE_FULL', 'OPERATION_RECONCILIATION_CAPACITY'].includes(code) });
const limits = { globalConcurrency: 2, targetConcurrency: 1, queueCapacity: 32, targetQueueCapacity: 32, unknownBudget: 32, observerCapacity: 256 };
const positive = (key, value) => { if (!Number.isSafeInteger(value) || value < 1) throw error(`INVALID_${key}`); return value; };
const targetLimit = (value, targetId) => typeof value === 'object' ? Object.hasOwn(value, targetId) ? value[targetId] : 1 : value;

/** Durable state owns admission/claims; this ready-target ring only chooses fair order. */
export function createOperationScheduler({ store, execute, beforeDispatch = () => {}, onChange = () => {}, now = Date.now, recover = true, ...configuration }) {
  if (!store || typeof execute !== 'function') throw error('INVALID_OPERATION_PORT');
  const settings = { ...limits };
  const ring = [], executing = new Map(), observers = new Set();
  let pumping = false, scheduled = false, paused = false, closed = false, lastError = null, expiryTimer, explicitUnknownBudget = false;
  const configure = patch => {
    const next = { ...settings };
    for (const key of Object.keys(limits)) if (patch[key] !== undefined) {
      if (['targetConcurrency', 'targetQueueCapacity'].includes(key) && typeof patch[key] === 'object' && patch[key] !== null) {
        next[key] = Object.fromEntries(Object.entries(patch[key]).map(([id, value]) => [id, positive(key, value)]));
      } else next[key] = positive(key, patch[key]);
    }
    if (patch.unknownBudget !== undefined) explicitUnknownBudget = true;
    if (!explicitUnknownBudget) next.unknownBudget = Math.max(limits.unknownBudget, next.globalConcurrency);
    Object.assign(settings, next);
    if (patch.paused !== undefined) paused = Boolean(patch.paused);
    schedule(); return { ...settings, paused };
  };
  const changed = job => {
    try { onChange(job); } catch { lastError = 'OPERATION_NOTIFICATION_FAILED'; }
    for (const observer of [...observers]) if (observer.id === job.id) observer.notify(job);
  };
  const persist = (id, patch, options) => { const job = store.update(id, patch, options); changed(job); return job; };
  const snapshot = () => {
    const jobs = store.list(), count = states => jobs.filter(job => states.includes(job.state)).length;
    return { ...settings, paused, closed, lastError, active: count(activeStates), queued: count(['queued']),
      accepted: count(['accepted']), unknown: count(['unknown']), observers: observers.size, targets: [...ring] };
  };
  function schedule() {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; try { drain(); } catch (failure) { lastError = failure.code ?? 'OPERATION_STORE_FAILED'; paused = true; } });
  }
  const finish = (id, outcome) => {
    try { const job = store.outcome(id, outcome); changed(job); }
    catch (failure) { lastError = failure.code ?? 'OPERATION_OUTCOME_PERSISTENCE_FAILED'; paused = true; }
    finally { executing.delete(id); schedule(); }
  };
  const launch = job => {
    const controller = new AbortController();
    const entry = { controller, completion: null };
    executing.set(job.id, entry);
    // starting is durable before crossing the asynchronous external-effect boundary.
    entry.completion = Promise.resolve().then(async () => {
      try { await beforeDispatch(job); }
      catch {
        finish(job.id, { failed: true, execution: { phase: 'settled', reason: 'input_failed', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false } }); return;
      }
      try {
        const current = store.get(job.id);
        if (current.state === 'terminating' || controller.signal.aborted) {
          finish(job.id, { failed: true, execution: { phase: 'settled', reason: 'cancel', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false } }); return;
        }
        if (current.expiresAt !== undefined && current.expiresAt <= now()) {
          persist(job.id, { state: 'expired', outcomeCertainty: 'not_dispatched' }, { expectedVersion: current.version });
          executing.delete(job.id); schedule(); return;
        }
        const running = persist(job.id, { state: 'running' }, { expectedState: 'starting' });
        let outcome;
        try { outcome = await execute({ ...running, signal: controller.signal }, { signal: controller.signal }); }
        catch { outcome = { failed: true, execution: { phase: 'settled', reason: 'transport_lost', remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true } }; }
        finish(job.id, outcome);
      } catch (failure) {
        // A failed running commit never authorizes an effect or a replacement dispatch.
        lastError = failure.code ?? 'OPERATION_DISPATCH_PERSISTENCE_FAILED'; paused = true; executing.delete(job.id);
      }
    });
  };
  function drain() {
    if (pumping || paused || closed) return snapshot();
    pumping = true;
    try {
      clearTimeout(expiryTimer);
      let queued = store.list({ state: 'queued' });
      for (const job of queued) if (job.expiresAt !== undefined && job.expiresAt <= now()) persist(job.id, { state: 'expired' }, { expectedVersion: job.version });
      queued = store.list({ state: 'queued' });
      const readyTargets = new Set(queued.map(job => job.targetId));
      for (let index = ring.length - 1; index >= 0; index--) if (!readyTargets.has(ring[index])) ring.splice(index, 1);
      for (const job of queued) if (!ring.includes(job.targetId)) ring.push(job.targetId);
      let misses = 0;
      // ponytail: bounded journal scans; SQL projection can replace these at higher capacity.
      while (ring.length && misses < ring.length) {
        const targetId = ring.shift(); ring.push(targetId);
        const candidates = queued.filter(job => job.targetId === targetId);
        let claimed = null;
        for (const candidate of candidates) {
          claimed = store.claim(candidate.id, { expectedVersion: candidate.version,
            globalConcurrency: settings.globalConcurrency, targetConcurrency: targetLimit(settings.targetConcurrency, targetId), unknownBudget: settings.unknownBudget });
          if (claimed) break;
          // A quarantined resource must not freeze other conflict keys on this target.
          const fenced = candidate.conflictKey && store.list({ states: [...activeStates, 'unknown'], targetId }).some(job => job.targetRevision === candidate.targetRevision && job.conflictKey === candidate.conflictKey);
          if (!fenced) break;
        }
        if (!claimed) { misses++; continue; }
        queued = queued.filter(job => job.id !== claimed.id); misses = 0;
        changed(claimed); launch(claimed);
        if (!queued.some(job => job.targetId === targetId)) ring.splice(ring.indexOf(targetId), 1);
      }
      const expiry = queued.reduce((earliest, job) => Number.isSafeInteger(job.expiresAt) ? Math.min(earliest, job.expiresAt) : earliest, Infinity);
      if (expiry !== Infinity) {
        expiryTimer = setTimeout(schedule, Math.min(2_147_483_647, Math.max(1, expiry - now())));
        expiryTimer.unref?.();
      }
      return snapshot();
    } finally { pumping = false; }
  }
  const enqueue = recordOrId => {
    if (typeof recordOrId !== 'string' && (!recordOrId || typeof recordOrId !== 'object')) throw error('INVALID_OPERATION_RECORD');
    if (typeof recordOrId !== 'string' && (typeof recordOrId.requestKey !== 'string' || !recordOrId.requestKey)) throw error('INVALID_OPERATION_REQUEST_KEY');
    const existing = typeof recordOrId === 'string' ? store.get(recordOrId) : store.find(recordOrId.requestKey)?.job;
    if (existing && existing.state !== 'accepted') return typeof recordOrId === 'string' ? existing : store.accept(recordOrId);
    if (closed || paused) throw error('OPERATION_ADMISSION_CLOSED');
    if (typeof recordOrId === 'string' && !existing) throw error('OPERATION_NOT_FOUND');
    const jobs = store.list(), queued = jobs.filter(job => job.state === 'queued');
    const targetId = existing?.targetId ?? recordOrId.targetId;
    if (queued.length >= settings.queueCapacity || queued.filter(job => job.targetId === targetId).length >= targetLimit(settings.targetQueueCapacity, targetId)) throw error('OPERATION_QUEUE_FULL');
    if (jobs.filter(job => job.state === 'unknown').length >= settings.unknownBudget) throw error('OPERATION_RECONCILIATION_CAPACITY');
    const accepted = typeof recordOrId === 'string' ? existing : store.accept(recordOrId);
    if (!accepted) throw error('OPERATION_NOT_FOUND');
    const job = persist(accepted.id, { state: 'queued' }, { expectedState: 'accepted', expectedVersion: accepted.version });
    schedule(); return job;
  };
  const cancel = id => {
    const job = store.get(id);
    if (!job) throw error('OPERATION_NOT_FOUND');
    if (terminal.has(job.state)) return job;
    if (['accepted', 'queued'].includes(job.state)) { const value = persist(id, { state: 'cancelled', outcomeCertainty: 'not_dispatched' }, { expectedVersion: job.version }); schedule(); return value; }
    const value = job.state === 'terminating' ? job : persist(id, { state: 'terminating', cancellationRequestedAt: now() }, { expectedVersion: job.version });
    executing.get(id)?.controller.abort(); return value;
  };
  const observe = (id, { timeoutMs = 25000, signal, afterVersion } = {}) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0))) throw error('INVALID_OPERATION_OBSERVER');
    signal?.throwIfAborted();
    const job = store.get(id);
    if (!job || terminal.has(job.state) || (afterVersion !== undefined && job.version > afterVersion)) return Promise.resolve(job);
    if (observers.size >= settings.observerCapacity) throw error('OPERATION_OBSERVER_CAPACITY');
    return new Promise((resolve, reject) => {
      let timer;
      const finishObserver = (value, failure) => {
        if (!observers.delete(observer)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure) reject(failure); else resolve(value);
      };
      const observer = { id, notify: value => { if (terminal.has(value.state) || (afterVersion !== undefined && value.version > afterVersion)) finishObserver(value); } };
      const abort = () => finishObserver(null, signal.reason ?? error('OPERATION_OBSERVER_ABORTED'));
      observers.add(observer); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { try { finishObserver(store.get(id)); } catch (failure) { finishObserver(null, failure); } }, timeoutMs);
    });
  };
  configure(configuration);
  if (recover) for (const job of store.recover()) changed(job);
  schedule();
  return { enqueue, observe, cancel, drain, snapshot, configure, get: store.get,
    transition(id, patch, options) { const job = persist(id, patch, options); schedule(); return job; },
    close() { closed = true; clearTimeout(expiryTimer); for (const observer of [...observers]) observer.notify({ id: observer.id, state: 'unknown', observerClosed: true }); },
  };
}
