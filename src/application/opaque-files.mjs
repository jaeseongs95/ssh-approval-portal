import { randomBytes, createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const keyValid = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_.:-]{16,128}$/.test(value);
const settled = new Set(['completed', 'failed', 'cancelled', 'expired', 'denied']);
const fail = code => { throw Object.assign(Error(code), { code, executionAttempted: false }); };
const publicErrorCodes = new Set([
  'ARTIFACT_QUOTA', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_HASH_MISMATCH', 'CHUNK_HASH_MISMATCH', 'ARTIFACT_CHUNK_CONFLICT',
  'ARTIFACT_EXPIRED', 'ARTIFACT_INCOMPLETE', 'ARTIFACT_NOT_WRITABLE', 'ARTIFACT_NOT_READY', 'ARTIFACT_BUSY', 'ARTIFACT_STORAGE_UNSAFE',
  'INVALID_OPERATION_KEY', 'INVALID_FILE_NAME', 'INVALID_FILE_SIZE', 'INVALID_FILE_HASH', 'INVALID_ARTIFACT_CHUNK', 'FILE_TOO_LARGE',
  'OPERATION_KEY_CONFLICT', 'INVALID_FILE_FLAG', 'INVALID_REMOTE_PATH', 'TARGET_REVISION_CONFLICT',
  'STAGED_FILE_CONSUMED', 'STAGED_FILE_EXPIRED', 'STAGED_FILE_CHANGED', 'MAINTENANCE', 'OPAQUE_FILES_CLOSED',
  'OPAQUE_ADMISSION_BUSY', 'OPAQUE_ACTION_CONFLICT', 'OPAQUE_ACTION_RECONCILIATION_REQUIRED', 'OPERATION_ACCEPTANCE_NOT_CONFIRMED', 'OPAQUE_FILES_UNAVAILABLE',
]);
// Older store ports throw messages. Match complete known literals only; never
// turn arbitrary messages, paths, filesystem error codes or stacks into output.
const legacyErrorCodes = new Map([
  ['Staged file unavailable', 'ARTIFACT_NOT_FOUND'], ['Unknown transfer', 'ARTIFACT_NOT_FOUND'], ['Invalid transfer ID', 'ARTIFACT_NOT_FOUND'],
  ['Invalid filename', 'INVALID_FILE_NAME'], ['Invalid operation key', 'INVALID_OPERATION_KEY'], ['Invalid file hash', 'INVALID_FILE_HASH'],
  ['Transfer is not writable', 'ARTIFACT_NOT_WRITABLE'], ['Invalid chunk', 'INVALID_ARTIFACT_CHUNK'],
  ['Chunk sequence or size mismatch', 'ARTIFACT_CHUNK_CONFLICT'], ['Incomplete or expired upload', 'ARTIFACT_INCOMPLETE'],
  ['Artifact hash mismatch', 'ARTIFACT_HASH_MISMATCH'], ['Artifact not ready', 'ARTIFACT_NOT_READY'], ['Staged file is busy', 'ARTIFACT_BUSY'],
  ['Operation key conflicts with staged file', 'OPERATION_KEY_CONFLICT'], ['Operation key conflicts with staged action', 'OPERATION_KEY_CONFLICT'],
  ['Unsafe artifact file', 'ARTIFACT_STORAGE_UNSAFE'], ['Artifact file changed', 'ARTIFACT_STORAGE_UNSAFE'], ['Unsafe artifact removal', 'ARTIFACT_STORAGE_UNSAFE'],
]);
export function opaqueFileErrorCode(error) {
  return publicErrorCodes.has(error?.code) ? error.code : legacyErrorCodes.get(error?.message) ?? 'ARTIFACT_INTERNAL_ERROR';
}
const published = (record, item, job) => record?.state === 'completed' && record.result?.failed === false &&
  !record.auditError && !record.metadata?.approval?.auditError && !job?.auditError &&
  record.result.data?.published === true && record.result.data.size === item.size && record.result.data.sha256 === item.sha256 &&
  (!record.result.execution || (record.result.execution.phase === 'settled' && record.result.execution.reason === 'exit' &&
  record.result.execution.remoteState === 'exited' && record.result.execution.exitCode === 0 &&
  record.result.execution.cleanupComplete === true && record.result.execution.requiresReconciliation === false));

/** Adapters authenticate first. ownerId is the composition root's verified owner
 * authority realm, never a client field or the UUID itself. Existing target
 * services retain approval, dispatch and publication authority. */
export function createOpaqueFileService({ store, targets, queue, files, journal, submissions, ownerId, now = () => Date.now() }) {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 512 || /[\x00-\x1f\x7f]/.test(ownerId)) throw Error('Verified opaque file owner required');
  if (!journal?.find || !journal?.get || !submissions?.run) throw Error('Durable opaque file admission required');
  const admissions = new Map(), reconciliations = new Map(), background = new Set(), cleanupFailures = new Map(), shutdown = new AbortController();
  let recovering = false;
  const owned = uuid => store.staged(uuid, ownerId);
  const guard = () => { if (shutdown.signal.aborted) fail('OPAQUE_FILES_CLOSED'); if (queue.maintenance) fail('MAINTENANCE'); if (recovering) fail('OPAQUE_ADMISSION_BUSY'); };
  const actionRecord = action => {
    const record = journal.get(action.requestId) ?? journal.find(action.requestKey)?.job;
    if (record && (record.id !== action.requestId || record.owner !== ownerId || record.requestKey !== action.requestKey ||
      record.inputDigest !== action.inputDigest || record.targetId !== action.targetId || record.targetRevision !== action.targetRevision || record.kind !== 'upload')) fail('OPAQUE_ACTION_CONFLICT');
    return record;
  };
  const reconcileOne = uuid => {
    if (reconciliations.has(uuid)) return reconciliations.get(uuid);
    const work = Promise.resolve().then(async () => {
      const item = owned(uuid);
      for (const action of item.actions) {
        const record = actionRecord(action);
        // Unknown is deliberately not settled: neither source deletion nor a
        // second remote publication is allowed without an authoritative outcome.
        if (!record || !settled.has(record.state)) continue;
        if (action.action === 'move' && published(record, item, queue.get(record.id))) await store.consumeStaged(uuid, ownerId, 'moved');
        if (action.state !== 'settled') store.settleStagedAction(uuid, ownerId, action.requestId, 'settled');
      }
      cleanupFailures.delete(uuid);
      return owned(uuid);
    });
    reconciliations.set(uuid, work);
    work.finally(() => { if (reconciliations.get(uuid) === work) reconciliations.delete(uuid); }).catch(() => {});
    return work;
  };
  const publicItem = item => ({ uuid: item.publicUUID,
    state: item.state === 'consumed' ? item.consumeReason : item.state === 'consuming' ? 'consuming' : now() >= item.expiresAt && !item.pinned ? 'expired' : item.state,
    fileName: item.fileName, size: item.size, sha256: item.sha256, expiresAt: item.expiresAt, received: item.received, sequence: item.sequence,
    ...(item.actions.length ? { operations: item.actions.map(action => {
      const record = actionRecord(action);
      return { operationKey: action.operationKey, action: action.action, requestId: action.requestId,
        state: record?.state ?? (action.state === 'refused' ? 'refused' : 'admission-unconfirmed') };
    }) } : {}) });
  const transfer = async (action, input, { signal } = {}) => {
    signal = AbortSignal.any([shutdown.signal, signal].filter(Boolean));
    guard(); signal?.throwIfAborted();
    if (!keyValid(input.operationKey)) fail('INVALID_OPERATION_KEY');
    for (const flag of ['overwrite', 'elevate']) if (input[flag] !== undefined && typeof input[flag] !== 'boolean') fail('INVALID_FILE_FLAG');
    const runtime = targets.select(input.target); runtime.verify();
    if (input.expectedTargetRevision !== undefined && input.expectedTargetRevision !== runtime.revision) fail('TARGET_REVISION_CONFLICT');
    const item = await reconcileOne(input.uuid);
    const contract = { uuid: item.publicUUID, action, targetId: runtime.id, targetRevision: runtime.revision,
      remotePath: input.remotePath, overwrite: input.overwrite ?? false, elevate: input.elevate ?? false };
    if (typeof contract.remotePath !== 'string') fail('INVALID_REMOTE_PATH');
    const inputDigest = digest(JSON.stringify(contract));
    const requestKey = 'opaque:' + digest(ownerId + '\0' + input.operationKey);
    const existing = item.actions.find(x => x.operationKey === input.operationKey);
    if (existing && existing.inputDigest !== inputDigest) fail('OPERATION_KEY_CONFLICT');
    const pending = admissions.get(requestKey);
    if (pending) {
      if (pending.inputDigest !== inputDigest) fail('OPERATION_KEY_CONFLICT');
      return pending.promise;
    }
    if (existing) {
      const record = actionRecord(existing);
      // A lost response and a process restart return the original request. If
      // admission never reached the journal, expose that uncertainty; no replay.
      return { uuid: item.publicUUID, requestId: existing.requestId, state: record?.state ?? (existing.state === 'refused' ? 'refused' : 'admission-unconfirmed') };
    }
    if (journal.find(requestKey)) fail('OPERATION_KEY_CONFLICT');
    if (['consuming', 'consumed'].includes(item.state)) fail('STAGED_FILE_CONSUMED');
    if (action === 'move' && item.actions.some(previous => {
      const record = actionRecord(previous);
      return record?.state === 'unknown' || (previous.state === 'submitted' && !record);
    })) fail('OPAQUE_ACTION_RECONCILIATION_REQUIRED');
    if (now() >= item.expiresAt) fail('STAGED_FILE_EXPIRED');
    const operation = store.reserveStagedAction(item.publicUUID, ownerId, { ...contract, operationKey: input.operationKey,
      requestKey, inputDigest, requestId: randomBytes(24).toString('hex') });
    const promise = Promise.resolve().then(async () => {
      try {
        runtime.verify();
        const source = {
          inspect: () => ({ allowed: true, sourceHost: 'server-staged-file' }),
          async open() {
            const current = owned(item.publicUUID);
            if (current.state !== 'ready' || current.sha256 !== item.sha256 || current.size !== item.size) fail('STAGED_FILE_CHANGED');
            const fd = await store.verified(current.id);
            return { stream: fd.createReadStream({ start: 0, autoClose: false }), expectedSize: item.size, close: () => fd.close() };
          },
        };
        await submissions.run({ id: operation.requestId, requestKey, owner: ownerId, inputDigest }, () => files.requestUpload({
          source, fileName: item.fileName, target: runtime.id, expectedTargetRevision: runtime.revision,
          remotePath: contract.remotePath, overwrite: contract.overwrite, elevate: contract.elevate,
        }, { signal, provenance: { sourceUUID: item.publicUUID, ownerId, requestId: operation.requestId } }));
        const record = actionRecord(operation);
        if (!record) fail('OPERATION_ACCEPTANCE_NOT_CONFIRMED');
        store.settleStagedAction(item.publicUUID, ownerId, operation.requestId, 'submitted');
        await reconcileOne(item.publicUUID);
        return { uuid: item.publicUUID, requestId: record.id, state: record.state };
      } catch (error) {
        const record = actionRecord(operation);
        if (record) {
          store.settleStagedAction(item.publicUUID, ownerId, operation.requestId, 'submitted');
          await reconcileOne(item.publicUUID);
          return { uuid: item.publicUUID, requestId: record.id, state: record.state };
        }
        store.settleStagedAction(item.publicUUID, ownerId, operation.requestId, 'refused');
        throw error;
      }
    });
    admissions.set(requestKey, { inputDigest, promise });
    try { return await promise; }
    finally { if (admissions.get(requestKey)?.promise === promise) admissions.delete(requestKey); }
  };
  return {
    async begin(meta) { guard(); return { uuid: (await store.beginStaged({ ...meta, ownerId })).publicUUID }; },
    async append({ uuid, sequence, bytes, sha256 }) {
      guard();
      if (!(bytes instanceof Uint8Array) || typeof sha256 !== 'string' || sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(sha256) || digest(bytes) !== sha256) fail('CHUNK_HASH_MISMATCH');
      const item = owned(uuid), ack = await store.append(item.id, sequence, bytes);
      return { uuid: item.publicUUID, ...ack };
    },
    async complete({ uuid }) { guard(); const item = owned(uuid); await store.finish(item.id); return { uuid: item.publicUUID }; },
    async stat({ uuid }) { return publicItem(await reconcileOne(uuid)); },
    copy: (input, options) => transfer('copy', input, options),
    move: (input, options) => transfer('move', input, options),
    async remove({ uuid }) { guard(); await reconcileOne(uuid); return publicItem(await store.consumeStaged(uuid, ownerId, 'removed')); },
    onTerminal(job) {
      for (const item of store.list()) if (item.purpose === 'staged' && item.ownerId === ownerId && item.actions.some(x => x.requestId === job.id)) {
        const work = reconcileOne(item.publicUUID);
        background.add(work);
        work.then(() => cleanupFailures.delete(item.publicUUID), error => cleanupFailures.set(item.publicUUID, error))
          .finally(() => background.delete(work)).catch(() => {});
      }
    },
    async reconcile() {
      if (admissions.size || recovering) fail('OPAQUE_ADMISSION_BUSY');
      recovering = true;
      let references;
      // Startup only, and only when there is an unaccepted reservation to clean.
      // list() defaults to maxRows + legacyRows: include retained legacy bodies,
      // and compare the count with the store's unfiltered SQL row count so a
      // truncated or failed read never becomes evidence of no references.
      const artifactReferences = () => {
        if (references) return references;
        if (!journal.list || !journal.usage || !queue.listAll) fail('OPAQUE_ACTION_RECONCILIATION_REQUIRED');
        const records = journal.list(), jobs = queue.listAll();
        if (!Array.isArray(records) || !Array.isArray(jobs) || records.length !== journal.usage().count) fail('OPAQUE_ACTION_RECONCILIATION_REQUIRED');
        references = new Set();
        for (const record of records) for (const id of [record.input?.operation?.artifactId, record.input?.artifactId,
          record.legacy?.original?.operation?.artifactId, record.metadata?.approval?.operation?.artifactId]) if (typeof id === 'string') references.add(id);
        for (const job of jobs) if (typeof job.operation?.artifactId === 'string') references.add(job.operation.artifactId);
        return references;
      };
      try {
        for (const item of store.list()) if (item.purpose === 'staged' && item.ownerId === ownerId) {
          for (const action of item.actions) if (action.state === 'reserved' && !actionRecord(action)) {
            // Admission precedes the first possible SSH publication. The journal
            // proves this reserved request was never accepted. Remove only clones
            // carrying its exact durable provenance; never replay the request.
            const referenced = artifactReferences();
            if (queue.get(action.requestId)) fail('OPAQUE_ACTION_RECONCILIATION_REQUIRED');
            for (const clone of store.list()) if (clone.provenance?.ownerId === ownerId && clone.provenance.sourceUUID === item.publicUUID && clone.provenance.requestId === action.requestId) {
              if (referenced.has(clone.id) || clone.submissionId || clone.targetId !== action.targetId || clone.targetRevision !== action.targetRevision ||
                  clone.remotePath !== action.remotePath || clone.overwrite !== action.overwrite || clone.elevate !== action.elevate ||
                  clone.fileName !== item.fileName || !['staging', 'ready'].includes(clone.state)) fail('OPAQUE_ACTION_RECONCILIATION_REQUIRED');
              await store.remove(clone.id);
            }
            store.settleStagedAction(item.publicUUID, ownerId, action.requestId, 'refused');
          }
          await reconcileOne(item.publicUUID);
          cleanupFailures.delete(item.publicUUID);
        }
      } finally { recovering = false; }
    },
    busy: () => recovering || admissions.size > 0 || reconciliations.size > 0 || background.size > 0 || cleanupFailures.size > 0,
    async close() {
      shutdown.abort();
      await Promise.allSettled([...admissions.values()].map(item => item.promise));
      await Promise.allSettled([...background]);
      if (cleanupFailures.size) throw new AggregateError([...cleanupFailures.values()], 'Opaque file cleanup requires reconciliation');
    },
  };
}
