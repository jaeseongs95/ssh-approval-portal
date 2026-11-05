import { randomBytes, createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const fail = code => { throw Object.assign(Error(code), { code, executionAttempted: false }); };
const terminal = new Set(['completed','failed','cancelled','expired','denied','unknown']);

/** One client-neutral operation API. Approval remains a server-side policy boundary. */
export function createOperations({ targets, queue, commands, files, journal, scheduler, submissions, outputs }) {
  const admissions = new Map();
  const view = record => {
    if (!record) fail('OPERATION_NOT_FOUND');
    const job = queue.get(record.id) ?? record.metadata?.approval ?? record.legacy?.original;
    return { ...job, id: record.id, kind: job?.kind ?? record.kind, operation: job?.operation ?? record.input?.operation ?? {},
      operationKey: record.requestKey, targetId: record.targetId, targetRevision: record.targetRevision,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
      state: record.state === 'accepted' ? job?.state ?? 'pending' : record.state,
      ...(record.result ? { result: record.result } : {}), ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}) };
  };
  return {
    async submit(input) {
      if (!['command','source','download'].includes(input.kind) || typeof input.operationKey !== 'string' || !/^[A-Za-z0-9_.:-]{16,128}$/.test(input.operationKey)) fail('INVALID_OPERATION_INPUT');
      const target = targets.select(input.target); target.verify();
      if (input.expectedTargetRevision !== undefined && input.expectedTargetRevision !== target.revision) fail('TARGET_REVISION_CONFLICT');
      const normalized = structuredClone({ ...input, target: target.id, expectedTargetRevision: target.revision });
      const inputDigest = createHash('sha256').update(canonical(normalized)).digest('hex');
      const previous = journal.find(input.operationKey)?.job;
      if (previous) {
        if (previous.owner !== 'mcp' || previous.inputDigest !== inputDigest || previous.targetRevision !== target.revision) fail('OPERATION_KEY_CONFLICT');
        return view(previous);
      }
      const pending = admissions.get(normalized.operationKey);
      if (pending) {
        if (pending.inputDigest !== inputDigest) fail('OPERATION_KEY_CONFLICT');
        return view(await pending.promise);
      }
      const identity = { id: randomBytes(24).toString('hex'), requestKey: normalized.operationKey, owner: 'mcp', inputDigest };
      // Register before invoking an asynchronous admission port; SQLite remains the durable authority.
      const promise = Promise.resolve().then(async () => {
        target.verify();
        if (target.revision !== normalized.expectedTargetRevision) fail('TARGET_REVISION_CONFLICT');
        const submitted = await submissions.run(identity, async () => {
          if (normalized.kind === 'command') return commands.run(normalized.command, normalized.target, normalized.operationKey, normalized.context ?? '', normalized.displayContext ?? '');
          if (normalized.kind === 'source') return commands.runSource({ source: normalized.source, argv: normalized.argv ?? [], cwd: normalized.cwd,
            elevate: normalized.elevate === true, requestKey: normalized.operationKey, context: normalized.context ?? '', displayContext: normalized.displayContext ?? '' }, normalized.target);
          return files.requestDownload({ target: normalized.target, expectedTargetRevision: normalized.expectedTargetRevision, remotePath: normalized.remotePath, elevate: normalized.elevate === true,
            context: normalized.context ?? '', displayContext: normalized.displayContext ?? '' });
        });
        const job = submitted?.job ?? submitted;
        const record = journal.get(job?.id ?? identity.id);
        if (!record) fail('OPERATION_ACCEPTANCE_NOT_CONFIRMED');
        if (record.requestKey !== normalized.operationKey || record.owner !== 'mcp' || record.inputDigest !== inputDigest || record.targetId !== normalized.target || record.targetRevision !== normalized.expectedTargetRevision) fail('OPERATION_KEY_CONFLICT');
        return record;
      });
      const admission = { inputDigest, promise };
      admissions.set(normalized.operationKey, admission);
      try { return view(await promise); }
      finally { if (admissions.get(normalized.operationKey) === admission) admissions.delete(normalized.operationKey); }
    },
    async observe({ id, operationKey, waitMs = 0, includeOutput = false, cursor = 0, maxBytes = 4096 }, { signal } = {}) {
      if ((!id && !operationKey) || (id && operationKey)) fail('OPERATION_SELECTOR_REQUIRED');
      let record = id ? journal.get(id) : journal.find(operationKey)?.job;
      if (!record) fail('OPERATION_NOT_FOUND');
      const target = targets.select(record.targetId); target.verify();
      if (record.targetRevision !== target.revision) fail('TARGET_REVISION_CONFLICT');
      const initialVersion = record.version;
      if (waitMs > 0 && !terminal.has(record.state)) record = await scheduler.observe(record.id, { timeoutMs: waitMs, signal, afterVersion: initialVersion });
      target.verify();
      if (record.targetRevision !== target.revision) fail('TARGET_REVISION_CONFLICT');
      const job = view(record), response = { job, waitTimedOut: waitMs > 0 && record.version === initialVersion && !terminal.has(record.state) };
      if (includeOutput) {
        const outputId = record.outputRef?.outputId ?? job.result?.output?.id;
        if (outputId) {
          const authorize = binding => { target.verify(); if (binding.targetId !== target.id || binding.targetRevision !== target.revision || binding.executionId !== record.id) fail('OUTPUT_BINDING_CONFLICT'); };
          // Raw checkpoints stay private. Public pages retain the existing whole-result redaction.
          if (job.result?.output?.state === 'ready') response.outputPage = outputs.read({ outputId, offsetBytes: cursor, maxBytes, format: 'text' }, authorize);
        }
      }
      return response;
    },
    cancel({ id }) {
      const record = journal.get(id); if (!record) fail('OPERATION_NOT_FOUND');
      const target = targets.select(record.targetId); target.verify();
      if (record.targetRevision !== target.revision) fail('TARGET_REVISION_CONFLICT');
      const result = scheduler.cancel(id); target.queue.syncOperation(result); return view(result);
    },
  };
}
