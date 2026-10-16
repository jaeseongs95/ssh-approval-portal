import { createHash } from 'node:crypto';

// Temporary test ports only. There is no adopted AIK/AGS/SSH joint contract.
// These objects are never imported by the product or used as remote credentials.
export function provisionalPorts({ delivery = 'acked', authorized = true } = {}) {
  const session = Object.freeze({ localFixture: true });
  const events = [], prepared = new Map();
  let sends = 0, sequence = 0;
  return {
    session, events,
    get sends() { return sends; },
    aik: {
      request(candidateSession, call) {
        if (candidateSession !== session) throw Error('invalid_local_session');
        for (const field of ['tool_call_id', 'tool_id', 'workspace_id', 'target',
          'input_revision', 'authorization_revision', 'arguments', 'effect_id']) {
          if (call[field] === undefined) throw Error('invalid_tool_call');
        }
        if (typeof call.target !== 'string' || !/^[a-z][a-z0-9+.-]{0,31}:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(call.target)
          || call.target.split('://')[1].split('/').some(part => ['', '.', '..'].includes(part))) throw Error('invalid_aik_target');
        events.push({ kind: 'aik_request', toolCallId: call.tool_call_id });
        if (!authorized) throw Error('aik_denied');
        if (!Number.isSafeInteger(call.authorization_revision) || call.authorization_revision < 1) throw Error('invalid_revision');
        return { status: 'authorized', synthetic: true };
      },
    },
    cli: {
      async call(operation, payload) {
        if (operation === 'prepare') {
          const body = JSON.parse(payload.body);
          if (body.schema !== 'aik.peer.v1' || body.kind !== 'task'
            || typeof body.correlation_id !== 'string' || !body.payload
            || Buffer.byteLength(payload.body) > 4096
            || !payload.sender?.host || !payload.sender?.sessionId
            || !payload.target?.host || !payload.target?.sessionId) throw Error('invalid_peer_request');
          const messageId = `synthetic-message-${++sequence}`;
          prepared.set(messageId, payload);
          return { messageId };
        }
        if (operation === 'send') {
          if (!prepared.has(payload.messageId)
            || !events.some(e => e.kind === 'send_intent' && e.messageId === payload.messageId)) throw Error('missing_intent');
          sends++;
          if (delivery === 'unknown') throw Error('send_unknown');
          return { messageId: payload.messageId, duplicate: false };
        }
        if (operation === 'status') return { status: { messageId: payload.messageId, state: delivery } };
        throw Error('unsupported_operation');
      },
    },
  };
}

export async function observeProvisionalTask(input, assessor, ports = provisionalPorts()) {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const toolCallId = `synthetic-call-${digest.slice(0, 16)}`;
  let authorization;
  try { authorization = ports.aik.request(ports.session, {
    tool_call_id: toolCallId, tool_id: 'synthetic.ssh.observe', workspace_id: 'synthetic-workspace',
    target: input.target, input_revision: digest, authorization_revision: 1,
    arguments: { command: input.command }, effect_id: `synthetic-effect-${digest.slice(0, 16)}`,
  }); } catch (error) { if (error.message !== 'aik_denied') throw error; }
  const base = { contractStatus: 'provisional', aik: 'temporary', ags: 'temporary',
    authorized: authorization?.status === 'authorized', ownerApproval: 'not_requested',
    executionStatus: 'not_dispatched', executions: 0, businessCompleted: false };
  if (!base.authorized) return { ...base, delivery: 'not_sent', assessment: null };
  const sender = { host: 'synthetic', sessionId: 'orchestrator' };
  const { messageId } = await ports.cli.call('prepare', { sender,
    target: { host: 'synthetic', sessionId: 'worker' }, ttlSeconds: 60,
    body: JSON.stringify({ correlation_id: toolCallId, kind: 'task',
      payload: { input_digest: `sha256:${digest}`, tool_call_id: toolCallId }, schema: 'aik.peer.v1' }),
  });
  ports.events.push({ kind: 'send_intent', messageId, toolCallId });
  try { await ports.cli.call('send', { sender, messageId }); }
  catch { return { ...base, messageId, delivery: 'unknown', assessment: null }; }
  const observed = await ports.cli.call('status', { sender, messageId });
  return { ...base, messageId, delivery: observed.status.state, assessment: await assessor.assess(input) };
}
