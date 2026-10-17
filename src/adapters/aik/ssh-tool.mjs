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
        ...(request.arguments.context === undefined ? {} : { context: request.arguments.context }) };
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
  };
}
