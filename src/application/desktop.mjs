import { randomUUID, createHash } from 'node:crypto';
import { desktopBinding, desktopActions, desktopFail } from '../domain/desktop-lease.mjs';
import { desktopState, transportDesktopState } from '../domain/desktop-state.mjs';

/** authorize enforces existing owner approval. GUI leases are never reassigned or pooled. */
export function createDesktopService({ adapter, authorize, verifyTarget, maxSessions = 2, maxPerOwner = 1,
  ttlMs = 900_000, idleTtlMs = 120_000, now = Date.now, id = randomUUID, onClose = () => {}, leaseKey = binding => binding.targetId,
  readState, canViewProtected = () => false } = {}) {
  if (typeof adapter?.open !== 'function' || typeof authorize !== 'function' || typeof verifyTarget !== 'function'
    || typeof leaseKey !== 'function' || typeof canViewProtected !== 'function' || readState !== undefined && typeof readState !== 'function'
    || ![maxSessions, maxPerOwner, ttlMs, idleTtlMs].every(value => Number.isSafeInteger(value) && value > 0)) desktopFail('DESKTOP_INVALID_CONFIG');
  const sessions = new Map(), resources = new Map(), openRequests = new Map(); let shuttingDown = false;
  const stateGeneration = state => JSON.stringify([state?.resourceGeneration ?? null, state?.generation ?? null, state?.sessionRef ?? null]);
  const view = item => ({ sessionId: item.id, ...item.binding, expiresAt: item.expiresAt, idleExpiresAt: item.idleExpiresAt, kind: 'desktop', readiness: item.readiness,
    ...(item.capabilities ? { capabilities: { ...item.capabilities } } : {}), lifecycle: item.lifecycle ?? 'attached',
    nextInputSequence: item.inputSequence + 1, lastInputReceipt: item.lastInput?.digest === null ? null : item.lastInput?.receipt ? { ...item.lastInput.receipt } : null });
  const live = item => {
    if (item.closed) desktopFail('DESKTOP_CLOSED');
    if (now() >= item.expiresAt || now() >= item.idleExpiresAt) desktopFail('DESKTOP_EXPIRED');
    if (item.desktop?.closed) desktopFail('DESKTOP_TRANSPORT_CLOSED');
  };
  const active = async item => {
    live(item);
    const authorized = await authorize(item.binding);
    live(item);
    if (authorized !== true) desktopFail('DESKTOP_NOT_AUTHORIZED');
    if (verifyTarget(item.binding) !== true) desktopFail('DESKTOP_STALE_TARGET');
  };
  const refreshState = async item => {
    const state = desktopState(item.desktop?.readState ? await item.desktop.readState()
      : readState ? await readState(item.binding, item.controller.signal) : transportDesktopState(now()));
    await active(item);
    if (item.readiness && stateGeneration(item.readiness) !== stateGeneration(state)) item.frame = undefined;
    item.readiness = state;
    return state;
  };
  const allowFrame = item => {
    if (item.readiness.ownerOnly && canViewProtected(item.binding) !== true) desktopFail('DESKTOP_OWNER_AUTH_REQUIRED');
  };
  const allowInput = item => {
    if (!item.readiness.inputAllowed && canViewProtected(item.binding) !== true) desktopFail(item.readiness.blockers[0] ?? 'DESKTOP_NOT_READY');
  };
  const dispose = item => {
    if (item.cleanup) return item.cleanup;
    item.closed = true; clearTimeout(item.timer);
    item.cleanup = Promise.resolve().then(async () => {
      let releaseSent = false, cleanupError, sessionState = 'unknown';
      try { releaseSent = (await item.desktop?.release())?.sent === true; }
      catch (error) { cleanupError = error.code ?? 'DESKTOP_RELEASE_FAILED'; }
      finally {
        item.controller.abort();
        // Keep the physical resource reserved until even a late open settles and closes.
        if (!item.desktop && item.opening) {
          try { item.desktop = await item.opening; } catch { /* The original open caller receives its failure. */ }
        }
        try {
          const result = await item.desktop?.close();
          if (result?.sessionState !== undefined && !['terminated', 'preserved', 'unknown'].includes(result.sessionState)) desktopFail('DESKTOP_INVALID_CLEANUP_RECEIPT');
          sessionState = ['terminated', 'preserved', 'unknown'].includes(result?.sessionState) ? result.sessionState
            : item.desktop && (item.lifecycle ?? item.desktop.lifecycle ?? 'attached') === 'attached' ? 'preserved' : 'unknown';
        }
        catch (error) { cleanupError ??= error.code ?? 'DESKTOP_CLOSE_FAILED'; }
        sessions.delete(item.id);
        if (resources.get(item.resourceKey) === item.id) resources.delete(item.resourceKey);
      }
      if (item.requestId !== null && item.requestId !== undefined) {
        const record = openRequests.get(item.requestId);
        if (record?.item === item) { record.item = null; record.promise = null; }
      }
      const receipt = { sessionId: item.id, closed: true, releaseSent, logout: false, sessionState, ...(cleanupError ? { cleanupError } : {}) };
      onClose(receipt); return receipt;
    });
    return item.cleanup;
  };
  const arm = item => {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { void dispose(item).catch(error => { item.cleanupError = error; }); }, Math.max(1, Math.min(item.expiresAt, item.idleExpiresAt) - now()));
    item.timer.unref?.();
  };
  const lookup = ({ sessionId, ownerId, epoch }) => {
    const item = sessions.get(sessionId);
    if (!item || item.binding.ownerId !== ownerId) desktopFail('DESKTOP_NOT_FOUND');
    if (item.binding.epoch !== epoch) desktopFail('DESKTOP_STALE_LEASE');
    return item;
  };
  const perform = (args, work) => {
    const item = lookup(args);
    if (item.pending >= 16) desktopFail('DESKTOP_BUSY');
    item.pending++;
    const result = item.tail.then(async () => {
      try {
        await active(item); const value = await work(item); await active(item);
        item.idleExpiresAt = Math.min(item.expiresAt, now() + idleTtlMs); arm(item); return value;
      } catch (error) {
        if (!['DESKTOP_STALE_FRAME', 'DESKTOP_INVALID_INPUT', 'DESKTOP_INPUT_SEQUENCE', 'DESKTOP_INPUT_CONFLICT',
          'DESKTOP_AUTH_REQUIRED', 'DESKTOP_SESSION_BINDING_UNVERIFIED', 'DESKTOP_SESSION_QUERY_FAILED',
          'DESKTOP_SESSION_QUERY_UNSUPPORTED', 'DESKTOP_NOT_READY', 'DESKTOP_OBSERVE_UNSUPPORTED', 'DESKTOP_INPUT_UNSUPPORTED'].includes(error.code)) {
          try {
            const cleanup = await dispose(item);
            if (cleanup.cleanupError) error.cleanupError = cleanup.cleanupError;
          } catch (cleanupError) { error.cleanupError = cleanupError.code ?? 'DESKTOP_CLEANUP_FAILED'; }
        }
        throw error;
      } finally { item.pending--; }
    });
    item.tail = result.catch(() => {}); return result;
  };
  return {
    async open(args) {
      if (shuttingDown) desktopFail('DESKTOP_CLOSED');
      const binding = desktopBinding(args);
      if (args.requestKey !== undefined && (typeof args.requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(args.requestKey))) desktopFail('DESKTOP_INVALID_INPUT');
      if (await authorize(binding) !== true) desktopFail('DESKTOP_NOT_AUTHORIZED');
      if (shuttingDown) desktopFail('DESKTOP_CLOSED');
      if (verifyTarget(binding) !== true) desktopFail('DESKTOP_STALE_TARGET');
      const requestId = args.requestKey === undefined ? null : JSON.stringify([binding.ownerId, args.requestKey]);
      const previous = requestId === null ? null : openRequests.get(requestId);
      if (previous) {
        if (previous.binding.targetId !== binding.targetId || previous.binding.targetRevision !== binding.targetRevision) desktopFail('DESKTOP_OPEN_CONFLICT');
        await previous.promise;
        const original = previous.item;
        if (!original || original.closed) desktopFail('DESKTOP_CLOSED');
        return perform({ sessionId: original.id, ownerId: original.binding.ownerId, epoch: original.binding.epoch }, async item => {
          await refreshState(item); return view(item);
        });
      }
      // Retain closed/failed request keys for this service lifetime; never evict into a duplicate open.
      if (requestId !== null && openRequests.size >= 4096) desktopFail('DESKTOP_OPEN_REQUEST_CAPACITY');
      const resourceKey = leaseKey(binding);
      if (typeof resourceKey !== 'string' || !resourceKey || resourceKey.length > 512) desktopFail('DESKTOP_INVALID_CONFIG');
      if (resources.has(resourceKey)) desktopFail('DESKTOP_RESOURCE_BUSY');
      if (sessions.size >= maxSessions || [...sessions.values()].filter(item => item.binding.ownerId === binding.ownerId).length >= maxPerOwner) desktopFail('DESKTOP_CAPACITY');
      const item = { id: id(), binding, resourceKey, requestId, expiresAt: now() + ttlMs, idleExpiresAt: now() + idleTtlMs,
        controller: new AbortController(), tail: Promise.resolve(), pending: 0, frameSequence: 0, inputSequence: 0, closed: false };
      // Reserve synchronously before opening the transport; no quota oversubscription.
      sessions.set(item.id, item); resources.set(resourceKey, item.id); arm(item);
      item.openResult = Promise.resolve().then(async () => {
        try {
          item.opening = Promise.resolve(adapter.open({ binding, signal: item.controller.signal }));
          item.desktop = await item.opening;
          if (item.closed) { await dispose(item); desktopFail('DESKTOP_EXPIRED'); }
          item.lifecycle = item.desktop.lifecycle ?? 'attached';
          if (item.desktop.readState !== undefined && typeof item.desktop.readState !== 'function') desktopFail('DESKTOP_INVALID_PROVIDER');
          if (!['attached', 'managed'].includes(item.lifecycle)) desktopFail('DESKTOP_INVALID_PROVIDER');
          if (item.desktop.capabilities !== undefined) {
            const capabilities = item.desktop.capabilities;
            if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
              || Object.keys(capabilities).some(key => !['observe', 'pointer', 'key', 'text'].includes(key))
              || Object.values(capabilities).some(value => typeof value !== 'boolean')) desktopFail('DESKTOP_INVALID_PROVIDER');
            item.capabilities = Object.freeze({ ...capabilities });
          }
          await active(item); await refreshState(item); return view(item);
        } catch (error) {
          try { await dispose(item); } catch (cleanupError) { error.cleanupError = cleanupError.code ?? 'DESKTOP_CLEANUP_FAILED'; }
          throw error;
        }
      });
      if (requestId !== null) openRequests.set(requestId, { binding, item, promise: item.openResult });
      return item.openResult;
    },
    status(args) {
      return perform(args, async item => { await refreshState(item); return view(item); });
    },
    observe(args) {
      return perform(args, async item => {
        await refreshState(item); allowFrame(item);
        if (item.capabilities?.observe === false) desktopFail('DESKTOP_OBSERVE_UNSUPPORTED');
        const generation = stateGeneration(item.readiness);
        const frame = await item.desktop.observe();
        // An owner-only diagnostic screen makes no atomic session/capture claim.
        // Attested backends must still fence changes across capture.
        if (!item.readiness.ownerOnly) { await refreshState(item); allowFrame(item); }
        if (generation !== stateGeneration(item.readiness)) desktopFail('DESKTOP_STALE_FRAME');
        item.frame = { frameId: `${item.id}:${++item.frameSequence}`, geometryRevision: frame.geometryRevision,
          width: frame.width, height: frame.height, coordinateSpace: 'physical-pixels', backendGeneration: generation };
        return { ...view(item), ...item.frame, nextInputSequence: item.inputSequence + 1, mimeType: 'image/png', data: frame.data.toString('base64') };
      });
    },
    authenticate(args) {
      if (canViewProtected(lookup(args).binding) !== true) desktopFail('DESKTOP_OWNER_AUTH_REQUIRED');
      if (args.confirmed !== true || !['sas', 'credential'].includes(args.action)
        || args.action === 'credential' && (typeof args.value !== 'string' || !args.value || args.value.length > 2048
          || !args.value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(args.value))
        || args.action === 'sas' && args.value !== undefined) desktopFail('DESKTOP_INVALID_INPUT');
      const actions = args.action === 'sas'
        ? [0xffe3, 0xffe9, 0xffff].map(keysym => ({ type: 'key', keysym, down: true })).concat(
          [0xffff, 0xffe9, 0xffe3].map(keysym => ({ type: 'key', keysym, down: false })))
        : [{ type: 'text', text: args.value }];
      // The owner chooses/focuses the Windows credential field. Never submit Enter automatically.
      // No model tool, job, audit payload or retained digest contains this one-time value.
      const request = { ...args, actions };
      delete request.value;
      args.value = undefined;
      return this.input(request, true).finally(() => { actions.length = 0; });
    },
    input(args, privateInput = false) {
      return perform(args, async item => {
        await refreshState(item); allowFrame(item); allowInput(item);
        if (!Number.isSafeInteger(args.sequence) || args.sequence < 1 || typeof args.requestKey !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(args.requestKey)) desktopFail('DESKTOP_INVALID_INPUT');
        if (typeof args.frameId !== 'string' || args.frameId.length > 256 || !Number.isSafeInteger(args.geometryRevision) || args.geometryRevision < 1) desktopFail('DESKTOP_INVALID_INPUT');
        const boundedActions = desktopActions(args.actions, 65536, 65536);
        if (boundedActions.some(action => item.capabilities?.[action.type] === false)) desktopFail('DESKTOP_INPUT_UNSUPPORTED');
        const digest = privateInput ? null : createHash('sha256').update(JSON.stringify({ frameId: args.frameId, geometryRevision: args.geometryRevision, actions: boundedActions })).digest('hex');
        if (args.sequence === item.inputSequence) {
          if (privateInput || item.lastInput?.digest === null) desktopFail('DESKTOP_INPUT_SEQUENCE');
          if (args.requestKey !== item.lastInput?.requestKey || digest !== item.lastInput.digest) desktopFail('DESKTOP_INPUT_CONFLICT');
          return item.lastInput.receipt;
        }
        if (args.sequence !== item.inputSequence + 1) desktopFail('DESKTOP_INPUT_SEQUENCE');
        if (args.requestKey === item.lastInput?.requestKey) desktopFail('DESKTOP_INPUT_CONFLICT');
        if (!item.frame || args.frameId !== item.frame.frameId || args.geometryRevision !== item.frame.geometryRevision) desktopFail('DESKTOP_STALE_FRAME');
        const actions = desktopActions(args.actions, item.frame.width, item.frame.height);
        // Refresh before dispatch to fence a resize since the agent's observation.
        const observedFrame = item.frame;
        const current = await item.desktop.observe({ includeImage: false }); await active(item);
        await refreshState(item); allowFrame(item); allowInput(item);
        if (!item.frame || observedFrame.backendGeneration !== stateGeneration(item.readiness)
          || current.geometryRevision !== item.frame.geometryRevision || current.width !== item.frame.width || current.height !== item.frame.height) {
          item.frame = undefined; desktopFail('DESKTOP_STALE_FRAME');
        }
        item.inputSequence = args.sequence;
        if (item.requestId !== null && item.requestId !== undefined) {
        const record = openRequests.get(item.requestId);
        if (record?.item === item) { record.item = null; record.promise = null; }
      }
      const receipt = { sessionId: item.id, sequence: args.sequence, requestKey: args.requestKey, state: 'sent' };
        // Reserve sequence before I/O. On failure the lease closes; uncertain input is never replayed.
        item.lastInput = { requestKey: args.requestKey, digest, receipt };
        await item.desktop.input(actions); return receipt;
      });
    },
    close(args) { return dispose(lookup(args)); },
    closeOwner(ownerId) {
      if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) desktopFail('DESKTOP_INVALID_BINDING');
      return Promise.allSettled([...sessions.values()].filter(item => item.binding.ownerId === ownerId).map(dispose));
    },
    async closeAll() { shuttingDown = true; return Promise.allSettled([...sessions.values()].map(dispose)); },
    size() { return sessions.size; },
  };
}
