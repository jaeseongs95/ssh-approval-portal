import { hash } from '../../domain/validation.mjs';
import { publicInputSchemas, publicOutputSchemas } from '../mcp/public-contract.mjs';

function operationResponse(name, reply) {
  let value;
  try {
    const text = reply?.content?.find(item => item.type === 'text')?.text;
    value = publicOutputSchemas[name].parse(reply?.structuredContent ?? (reply?.contractVersion ? reply : JSON.parse(text)));
    if (reply?.structuredContent && text !== undefined && JSON.stringify(publicOutputSchemas[name].parse(JSON.parse(text))) !== JSON.stringify(value)) throw Error('SSH representations differ');
    if (reply?.isError === true && value.ok) throw Error('SSH error result cannot be successful');
  } catch { throw Error('Invalid SSH 2.0 response; reconcile without replay'); }
  if (!value.ok) throw Object.assign(Error(`SSH request refused (${value.error.code})`), value.error);
  return value.data;
}

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
      const args = { kind: 'command', target: request.arguments.target, command: request.arguments.command, operationKey: requestKey,
        ...(request.arguments.expectedTargetRevision === undefined ? {} : { expectedTargetRevision: request.arguments.expectedTargetRevision }),
        ...(request.arguments.context === undefined ? {} : { context: request.arguments.context }),
        ...(request.arguments.displayContext === undefined ? {} : { displayContext: request.arguments.displayContext }) };
      publicInputSchemas.submit.parse(args);
      await authority.recordDispatch(authorization, requestKey);
      await authority.revalidate(authorization);
      let job;
      try {
        job = operationResponse('submit', await mcp.call('submit', args));
        if (job.operationKey !== requestKey || job.kind !== 'command') throw Error('SSH operation binding mismatch');
        await authority.bindRequest(authorization, { requestKey, requestId: job.id });
      } catch (error) {
        await authority.recordReceipt(authorization, { requestKey, status: error.executionAttempted === false ? 'failed' : 'unknown' });
        if (error.executionAttempted === false) throw error;
        throw Error('SSH dispatch outcome unknown; reconcile without replay');
      }
      return job;
    },
    async status(id) {
      const authorization = await authority.lookupRequest(id);
      if (!authorization) throw Error('Original AIK binding required for observation');
      const job = operationResponse('observe', await mcp.call('observe', { id, includeOutput: false }));
      if (job.id !== id) throw Error('SSH operation binding mismatch');
      if (['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown'].includes(job.state)) {
        await authority.recordReceipt(authorization, { requestId: id, status: job.auditFailure || job.execution?.requiresReconciliation || job.execution?.remoteState === 'unknown' ? 'unknown' : job.state === 'completed' ? 'succeeded'
          : job.state === 'unknown' ? 'unknown' : job.state === 'failed' ? 'failed' : 'cancelled' });
      }
      return job;
    },
    async output(id, { cursor, offsetBytes = 0, maxBytes = 4096, format = 'text' } = {}) {
      if (format !== 'text') throw Error('SSH 2.0 output supports text pages only');
      if (cursor !== undefined && offsetBytes !== 0 && cursor !== offsetBytes) throw Error('Conflicting output cursors');
      cursor ??= offsetBytes;
      const input = publicInputSchemas.observe.parse({ id, includeOutput: true, cursor, maxBytes });
      if (typeof authority.revalidateObservation !== 'function') throw Error('AIK output-observation capability unavailable');
      const authorization = await authority.lookupRequest(id);
      if (!authorization) throw Error('Original AIK binding required for observation');
      await authority.revalidateObservation(authorization, { requestId: id });
      const job = operationResponse('observe', await mcp.call('observe', { id, includeOutput: false }));
      const output = job.output;
      if (job.id !== id || output?.state !== 'ready' || !/^[a-f0-9]{48}$/.test(output.id)) throw Error('Original stored output unavailable; do not replay');
      const observation = { requestId: id, outputId: output.id, targetId: job.targetId ?? 'default', targetRevision: job.targetRevision };
      await authority.revalidateObservation(authorization, observation);
      const observed = operationResponse('observe', await mcp.call('observe', { id, includeOutput: true, cursor: input.cursor, maxBytes: input.maxBytes }));
      if (observed.id !== id || observed.targetId !== job.targetId || observed.targetRevision !== job.targetRevision || observed.output?.id !== output.id || observed.output.state !== 'ready') throw Error('Output observation binding mismatch');
      const page = observed.outputPage;
      if (!page || page.cursor !== cursor || page.bytes !== Buffer.byteLength(page.text) || page.nextCursor !== cursor + page.bytes
        || page.bytes > input.maxBytes || page.nextCursor > page.totalBytes || page.eof !== (page.nextCursor === page.totalBytes)
        || output.bytes !== null && output.bytes !== page.totalBytes) throw Error('Original stored output unavailable; do not replay');
      await authority.revalidateObservation(authorization, observation);
      return page;
    },
  };
}
