import { randomUUID, createHash } from 'node:crypto';
import { desktopBinding, desktopActions, desktopFail } from '../domain/desktop-lease.mjs';

/** authorize enforces existing owner approval. GUI leases are never reassigned or pooled. */
export function createDesktopService({ adapter, authorize, verifyTarget, maxSessions = 2, maxPerOwner = 1,
  ttlMs = 900_000, idleTtlMs = 120_000, now = Date.now, id = randomUUID, onClose = () => {} } = {}) {
  if (typeof adapter?.open !== 'function' || typeof authorize !== 'function' || typeof verifyTarget !== 'function'
    || ![maxSessions, maxPerOwner, ttlMs, idleTtlMs].every(value => Number.isSafeInteger(value) && value > 0)) desktopFail('DESKTOP_INVALID_CONFIG');
  const sessions = new Map(); let shuttingDown = false;
  const view = item => ({ sessionId: item.id, ...item.binding, expiresAt: item.expiresAt, idleExpiresAt: item.idleExpiresAt, kind: 'desktop' });
  const active = item => {
    if (item.closed) desktopFail('DESKTOP_CLOSED');
    if (now() >= item.expiresAt || now() >= item.idleExpiresAt) desktopFail('DESKTOP_EXPIRED');
    if (item.desktop?.closed) desktopFail('DESKTOP_TRANSPORT_CLOSED');
    if (verifyTarget(item.binding) !== true) desktopFail('DESKTOP_STALE_TARGET');
  };
  const dispose = item => {
    if (item.cleanup) return item.cleanup;
    item.closed = true; clearTimeout(item.timer);
    item.cleanup = Promise.resolve().then(async () => {
      let releaseSent = false, cleanupError;
      try { releaseSent = (await item.desktop?.release())?.sent === true; }
      catch (error) { cleanupError = error.code ?? 'DESKTOP_RELEASE_FAILED'; }
      finally {
        item.controller.abort();
        try { await item.desktop?.close(); }
        catch (error) { cleanupError ??= error.code ?? 'DESKTOP_CLOSE_FAILED'; }
        sessions.delete(item.id);
      }
      const receipt = { sessionId: item.id, closed: true, releaseSent, logout: false, ...(cleanupError ? { cleanupError } : {}) };
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
        active(item); const value = await work(item); active(item);
        item.idleExpiresAt = Math.min(item.expiresAt, now() + idleTtlMs); arm(item); return value;
      } catch (error) {
        if (!['DESKTOP_STALE_FRAME', 'DESKTOP_INVALID_INPUT', 'DESKTOP_INPUT_SEQUENCE', 'DESKTOP_INPUT_CONFLICT'].includes(error.code)) {
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
      if (authorize(binding) !== true) desktopFail('DESKTOP_NOT_AUTHORIZED');
      if (verifyTarget(binding) !== true) desktopFail('DESKTOP_STALE_TARGET');
      if (sessions.size >= maxSessions || [...sessions.values()].filter(item => item.binding.ownerId === binding.ownerId).length >= maxPerOwner) desktopFail('DESKTOP_CAPACITY');
      const item = { id: id(), binding, expiresAt: now() + ttlMs, idleExpiresAt: now() + idleTtlMs,
        controller: new AbortController(), tail: Promise.resolve(), pending: 0, frameSequence: 0, inputSequence: 0, closed: false };
      // Reserve synchronously before opening the transport; no quota oversubscription.
      sessions.set(item.id, item); arm(item);
      try {
        item.desktop = await adapter.open({ binding, signal: item.controller.signal });
        if (item.closed) { await item.desktop.close(); desktopFail('DESKTOP_EXPIRED'); }
        active(item); return view(item);
      } catch (error) {
        try { await dispose(item); } catch (cleanupError) { error.cleanupError = cleanupError.code ?? 'DESKTOP_CLEANUP_FAILED'; }
        throw error;
      }
    },
    observe(args) {
      return perform(args, async item => {
        const frame = await item.desktop.observe();
        item.frame = { frameId: `${item.id}:${++item.frameSequence}`, geometryRevision: frame.geometryRevision,
          width: frame.width, height: frame.height, coordinateSpace: 'physical-pixels' };
        return { ...view(item), ...item.frame, nextInputSequence: item.inputSequence + 1, mimeType: 'image/png', data: frame.data.toString('base64') };
      });
    },
    input(args) {
      return perform(args, async item => {
        if (!Number.isSafeInteger(args.sequence) || args.sequence < 1 || typeof args.requestKey !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(args.requestKey)) desktopFail('DESKTOP_INVALID_INPUT');
        if (typeof args.frameId !== 'string' || args.frameId.length > 256 || !Number.isSafeInteger(args.geometryRevision) || args.geometryRevision < 1) desktopFail('DESKTOP_INVALID_INPUT');
        const boundedActions = desktopActions(args.actions, 65536, 65536);
        const digest = createHash('sha256').update(JSON.stringify({ frameId: args.frameId, geometryRevision: args.geometryRevision, actions: boundedActions })).digest('hex');
        if (args.sequence === item.inputSequence) {
          if (args.requestKey !== item.lastInput?.requestKey || digest !== item.lastInput.digest) desktopFail('DESKTOP_INPUT_CONFLICT');
          return item.lastInput.receipt;
        }
        if (args.sequence !== item.inputSequence + 1) desktopFail('DESKTOP_INPUT_SEQUENCE');
        if (args.requestKey === item.lastInput?.requestKey) desktopFail('DESKTOP_INPUT_CONFLICT');
        if (!item.frame || args.frameId !== item.frame.frameId || args.geometryRevision !== item.frame.geometryRevision) desktopFail('DESKTOP_STALE_FRAME');
        const actions = desktopActions(args.actions, item.frame.width, item.frame.height);
        // Refresh before dispatch to fence a resize since the agent's observation.
        const current = await item.desktop.observe({ includeImage: false }); active(item);
        if (current.geometryRevision !== item.frame.geometryRevision || current.width !== item.frame.width || current.height !== item.frame.height) {
          item.frame = undefined; desktopFail('DESKTOP_STALE_FRAME');
        }
        item.inputSequence = args.sequence;
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
