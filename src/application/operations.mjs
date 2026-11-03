import { randomBytes, createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const fail = code => { throw Object.assign(Error(code), { code, executionAttempted: false }); };
const terminal = new Set(['completed','failed','cancelled','expired','denied','unknown']);

/** One client-neutral operation API. Approval remains a server-side policy boundary. */
export function createOperations({ targets, queue, commands, files, journal, scheduler, submissions, outputs }) {
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
      const normalized = { ...input, target: target.id, expectedTargetRevision: target.revision };
      const inputDigest = createHash('sha256').update(canonical(normalized)).digest('hex');
      const previous = journal.find(input.operationKey)?.job;
      if (previous) {
        if (previous.owner !== 'mcp' || previous.inputDigest !== inputDigest || previous.targetRevision !== target.revision) fail('OPERATION_KEY_CONFLICT');
        return view(previous);
      }
      const identity = { id: randomBytes(24).toString('hex'), requestKey: input.operationKey, owner: 'mcp', inputDigest };
      const submitted = await submissions.run(identity, async () => {
        if (input.kind === 'command') return commands.run(input.command, target.id, input.operationKey, input.context ?? '', input.displayContext ?? '');
        if (input.kind === 'source') return commands.runSource({ source: input.source, argv: input.argv ?? [], cwd: input.cwd,
          elevate: input.elevate === true, requestKey: input.operationKey, context: input.context ?? '', displayContext: input.displayContext ?? '' }, target.id);
        return files.requestDownload({ target: target.id, expectedTargetRevision: target.revision, remotePath: input.remotePath, elevate: input.elevate === true });
      });
      const job = submitted?.job ?? submitted;
      const record = journal.get(job?.id ?? identity.id);
      if (!record) fail('OPERATION_ACCEPTANCE_NOT_CONFIRMED');
      return view(record);
    },
    async observe({ id, operationKey, waitMs = 0, includeOutput = false, cursor = 0, maxBytes = 4096 }, { signal } = {}) {
      if ((!id && !operationKey) || (id && operationKey)) fail('OPERATION_SELECTOR_REQUIRED');
      let record = id ? journal.get(id) : journal.find(operationKey)?.job;
      if (!record) fail('OPERATION_NOT_FOUND');
      const target = targets.select(record.targetId); target.verify();
      if (record.targetRevision !== target.revision) fail('TARGET_REVISION_CONFLICT');
      const initialVersion = record.version;
      if (waitMs > 0 && !terminal.has(record.state)) record = await scheduler.observe(record.id, { timeoutMs: waitMs, signal, afterVersion: initialVersion });
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
