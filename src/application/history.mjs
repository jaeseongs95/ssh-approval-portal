import { AGENT_CLI_CONTRACT, agentCliProviders } from '../domain/agent-cli.mjs';
import { hash } from '../domain/validation.mjs';
import { COMMAND_MAX_BYTES } from '../contracts/ports.mjs';

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_RESPONSE_BYTES = 256 * 1024;
const terminal = ['completed', 'failed', 'denied', 'expired', 'unknown'];
const states = [...terminal, 'pending', 'evaluating', 'running'];
const validId = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const validTarget = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const digest = value => hash(JSON.stringify(value));
const order = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const fail = (code, status = 400) => { throw Object.assign(Error(code), { historyCode: code, status }); };
const integer = value => {
  if (!/^-?(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) fail('HISTORY_INVALID_RANGE');
  return Number(value);
};
const cliKeys = ['agentCliContract', 'agentCliTargetId', 'agentCliTargetRevision', 'agentCliProfile', 'agentCliProvider'];
const fields = ['id', 'kind', 'state', 'createdAt', 'targetId', 'targetRevision', 'profile', 'command', 'targetDisplayName'];
function metadata(job) {
  const value = Object.fromEntries(fields.map(key => [key, job[key] ?? undefined]));
  value.kind ??= job.operation?.kind;
  value.command ??= job.operation?.command;
  for (const key of cliKeys) value[key] = job[key] ?? job.operation?.[key] ?? undefined;
  value.targetId ??= value.agentCliTargetId ?? 'default';
  return value;
}
const identity = row => digest([row.id, row.kind, row.createdAt, row.targetId, row.targetRevision, row.profile, row.command, ...cliKeys.map(key => row[key])]);
const publicMemory = job => ({ ...Object.fromEntries(['id', 'targetId', 'targetRevision', 'targetDisplayName', 'hostKey', 'decision', 'profile', 'commandClass', 'target', 'state', 'approvalMode', 'createdAt', 'expiresAt', 'finishedAt', 'result', 'auditError'].map(key => [key, job[key]])),
  kind: job.kind ?? job.operation.kind, command: job.command ?? job.operation.command, operation: { ...job.operation } });

// 포트는 기존 연결의 읽기만 제공한다. 승인·만료 처리·원격 접속을 호출하지 않는다.
export function createRetainedHistory({ commandJournal, cliJournal, readQueue, readTargets, verifyCliTarget, present, now = Date.now }) {
  const providers = new Set(agentCliProviders().map(provider => provider.id));
  return function history(params) {
    const keys = ['from', 'to', 'target', 'state', 'q', 'cursor'];
    if ([...params].some(([key]) => !keys.includes(key) || params.getAll(key).length !== 1)) fail('HISTORY_INVALID_FIELDS');
    const query = { from: params.has('from') ? integer(params.get('from')) : null, to: params.has('to') ? integer(params.get('to')) : null,
      target: params.get('target') || null, state: params.get('state') || null, q: (params.get('q') ?? '').trim().toLowerCase() };
    if (query.from !== null && query.to !== null && query.from >= query.to) fail('HISTORY_INVALID_RANGE');
    if (query.target !== null && !validTarget(query.target) || query.state !== null && !terminal.includes(query.state)) fail('HISTORY_INVALID_FILTER');
    if ([...(params.get('q') ?? '')].length > 200 || Buffer.byteLength(params.get('q') ?? '', 'utf8') > 800) fail('HISTORY_SEARCH_TOO_LARGE');
    const filterHash = digest(query), observedAt = now();
    let asOf = observedAt, before, beforeId;
    if (params.has('cursor')) {
      const encoded = params.get('cursor');
      if (!encoded || Buffer.byteLength(encoded) > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail('HISTORY_INVALID_CURSOR');
      let cursor;
      try {
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) fail('HISTORY_INVALID_CURSOR');
        cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch { fail('HISTORY_INVALID_CURSOR'); }
      if (!cursor || Array.isArray(cursor) || Object.keys(cursor).sort().join(',') !== 'asOf,before,beforeId,filterHash,v' || cursor.v !== 1 || cursor.filterHash !== filterHash ||
          !Number.isSafeInteger(cursor.asOf) || cursor.asOf < 0 || !Number.isSafeInteger(cursor.before) || cursor.before < 0 || cursor.before > cursor.asOf || !validId(cursor.beforeId)) fail('HISTORY_INVALID_CURSOR');
      ({ asOf, before, beforeId } = cursor);
    }
    const coverage = { commandJournal: Boolean(commandJournal), cliJournal: Boolean(cliJournal), fileHistory: 'memory-only', snapshot: false,
      registeredTargetsOnly: true, cliCurrentBindingOnly: true, metadataIncomplete: false };
    const targets = new Map(readTargets().map(target => [target.id, target])), checkedCli = new Map();
    const allowed = row => {
      if (!validId(row.id) || !['command', 'upload', 'download'].includes(row.kind) || !states.includes(row.state) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
          !validTarget(row.targetId) || typeof row.profile !== 'string' || row.kind === 'command' && (typeof row.command !== 'string' || Buffer.byteLength(row.command) > COMMAND_MAX_BYTES)) {
        coverage.metadataIncomplete = true; return false;
      }
      const target = targets.get(row.targetId);
      if (!target) return false;
      if (row.agentCliContract !== undefined) {
        if (row.agentCliContract !== AGENT_CLI_CONTRACT || !target.enabled || row.agentCliTargetId !== target.id || row.agentCliTargetRevision !== target.revision ||
            row.agentCliProfile !== target.writeProfile || row.profile !== target.writeProfile || !providers.has(row.agentCliProvider)) return false;
        if (!checkedCli.has(target.id)) {
          try { verifyCliTarget(target.id); checkedCli.set(target.id, true); }
          catch { checkedCli.set(target.id, false); coverage.metadataIncomplete = true; }
        }
        if (!checkedCli.get(target.id)) return false;
      }
      return true;
    };
    const matches = row => (query.from === null || row.createdAt >= query.from) && (query.to === null || row.createdAt < query.to) && row.createdAt <= asOf &&
      (before === undefined || row.createdAt < before || row.createdAt === before && row.id < beforeId) && (!query.target || row.targetId === query.target) &&
      (query.state ? row.state === query.state : terminal.includes(row.state)) && (!query.q || [row.id, row.command, row.targetDisplayName, row.targetId, row.operationText].join(' ').toLowerCase().includes(query.q));
    const candidates = [], memory = new Map(), journals = new Map();
    const offer = candidate => {
      if (!matches(candidate.row)) return;
      candidates.push(candidate); candidates.sort((a, b) => order(a.row, b.row));
      if (candidates.length > HISTORY_PAGE_SIZE + 1) candidates.pop();
    };
    // ponytail: 상위 21개만 보유한다. 장부 상한에서 검색 비용이 커지면 별도 승인된 인덱스를 검토한다.
    for (const job of readQueue()) {
      const row = metadata(job);
      if (row.kind !== 'command') row.operationText = JSON.stringify(job.operation);
      if (!allowed(row)) continue;
      if (memory.has(row.id)) fail('HISTORY_AMBIGUOUS_REQUEST', 409);
      const candidate = { row, job, storage: 'memory', stateSource: 'memory' };
      memory.set(row.id, candidate); offer(candidate);
    }
    for (const [storage, journal] of [['command', commandJournal], ['cli', cliJournal]]) {
      if (!journal) continue;
      for (const source of journal.historyRows()) {
        const row = metadata(source);
        if (!allowed(row)) continue;
        if (row.kind !== 'command' || storage === 'cli' && row.agentCliContract !== AGENT_CLI_CONTRACT || storage === 'command' && row.agentCliContract !== undefined) { coverage.metadataIncomplete = true; continue; }
        if (journals.has(row.id)) fail('HISTORY_AMBIGUOUS_REQUEST', 409);
        journals.set(row.id, true);
        const current = memory.get(row.id);
        if (current) {
          if (identity(current.row) !== identity(row)) fail('HISTORY_AMBIGUOUS_REQUEST', 409);
          current.storage = storage;
        } else offer({ row, journal, storage, stateSource: 'journal' });
      }
    }
    const result = { items: [], nextCursor: null, asOf, observedAt, coverage };
    const cursorFor = row => Buffer.from(JSON.stringify({ v: 1, asOf, before: row.createdAt, beforeId: row.id, filterHash })).toString('base64url');
    for (let index = 0; index < Math.min(candidates.length, HISTORY_PAGE_SIZE); index++) {
      const candidate = candidates[index], { row } = candidate, target = targets.get(row.targetId);
      const job = candidate.job ? publicMemory(candidate.job) : candidate.journal.historyJob(row.id);
      if (identity(metadata(job)) !== identity(row)) fail('HISTORY_ENTRY_CHANGED', 409);
      let item;
      try { item = present(job); } catch { fail('HISTORY_METADATA_UNAVAILABLE', 409); }
      item.history = { stateSource: candidate.stateSource, storage: candidate.storage,
        targetStatus: !target.enabled ? 'disabled' : row.targetRevision !== undefined && row.targetRevision !== target.revision || row.profile !== target.writeProfile ? 'changed' : 'active' };
      result.items.push(item);
      result.nextCursor = index + 1 < candidates.length ? cursorFor(row) : null;
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > HISTORY_RESPONSE_BYTES) {
        result.items.pop();
        if (!result.items.length) fail('HISTORY_ENTRY_TOO_LARGE', 413);
        result.nextCursor = cursorFor(candidates[index - 1].row); break;
      }
    }
    return result;
  };
}
