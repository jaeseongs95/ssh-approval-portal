import { hash } from '../../domain/validation.mjs';

/** Trusted AIK backend ports only. Sessions and authorization objects never cross MCP. */
export function createAikSshTool({ authority, mcp }) {
  if (['authorize', 'revalidate', 'recordDispatch', 'bindRequest', 'lookupRequest', 'recordReceipt'].some(key => typeof authority?.[key] !== 'function') || typeof mcp?.call !== 'function') throw Error('Trusted AIK authority and MCP ports required');
  return {
    async run(call) {
      // AIK owns construction/validation of ToolCall and its nonserializable session.
      const request = structuredClone(call);
      const authorization = await authority.authorize(request);
      if (authorization?.status !== 'authorized' || typeof authorization.binding_digest !== 'string' || !authorization.binding_digest
        || !Number.isSafeInteger(authorization.authorization_revision) || authorization.authorization_revision < 1) throw Error('Invalid AIK authorization');
      await authority.revalidate(authorization);
      const requestKey = 'aik:' + hash(JSON.stringify({ toolCall: request.tool_call_id, effect: request.effect_id,
        binding: authorization.binding_digest, revision: authorization.authorization_revision }));
      const args = { target: request.arguments.target, command: request.arguments.command, requestKey,
        ...(request.arguments.context === undefined ? {} : { context: request.arguments.context }),
        ...(request.arguments.displayContext === undefined ? {} : { displayContext: request.arguments.displayContext }) };
      await authority.recordDispatch(authorization, requestKey);
      await authority.revalidate(authorization);
      let job;
      try {
        job = await mcp.call('run-command', args);
        if (!job || typeof job.id !== 'string') throw Error('Invalid SSH response');
        await authority.bindRequest(authorization, { requestKey, requestId: job.id });
      } catch {
        await authority.recordReceipt(authorization, { requestKey, status: 'unknown' });
        throw Error('SSH dispatch outcome unknown; reconcile without replay');
      }
      return job;
    },
    async status(id) {
      const authorization = await authority.lookupRequest(id);
      if (!authorization) throw Error('Original AIK binding required for observation');
      const job = await mcp.call('get-request-status', { id });
      if (['completed', 'failed', 'denied', 'expired', 'unknown'].includes(job?.state)) {
        await authority.recordReceipt(authorization, { requestId: id, status: job.state === 'completed' ? 'succeeded'
          : job.state === 'unknown' ? 'unknown' : job.state === 'failed' ? 'failed' : 'cancelled' });
      }
      return job;
    },
    async output(id, { offsetBytes = 0, maxBytes = 4096, format = 'text' } = {}) {
      if (typeof authority.revalidateObservation !== 'function') throw Error('AIK output-observation capability unavailable');
      const authorization = await authority.lookupRequest(id);
      if (!authorization) throw Error('Original AIK binding required for observation');
      await authority.revalidateObservation(authorization, { requestId: id });
      const job = await mcp.call('get-request-status', { id });
      const output = job?.result?.structuredContent?.output;
      if (job?.id !== id || output?.executionId !== id || output.state !== 'ready' || !/^[a-f0-9]{48}$/.test(output.id)) throw Error('Original stored output unavailable; do not replay');
      const observation = { requestId: id, outputId: output.id, targetId: job.targetId ?? 'default', targetRevision: job.targetRevision };
      await authority.revalidateObservation(authorization, observation);
      const page = await mcp.call('read-command-output', { outputId: output.id, ...(job.targetId ? { target: job.targetId } : {}), offsetBytes, maxBytes, format });
      const metadata = page?.structuredContent ?? page;
      if (metadata?.outputId !== output.id || metadata?.executionId !== id) throw Error('Output observation binding mismatch');
      await authority.revalidateObservation(authorization, observation);
      return page;
    },
  };
}
