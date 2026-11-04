import {createHash} from 'node:crypto';
import {constants, closeSync, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {join} from 'node:path';

// Internal values are sensitive evidence. Callers must not return or log snapshots.
const hash = value => createHash('sha256').update(value).digest('hex');
const rowHash = row => hash(JSON.stringify(row));
const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'unknown']);
const idPattern = /^[a-f0-9]{48}$/;
const maxPayload = 16 * 1024 * 1024;
export const BASELINE_PRESERVATION_CONTRACT = 'baseline-preservation-v1';
export const PRESERVATION_COUNTERS = ['commandRequestsChecked', 'cliRequestsChecked', 'outputsChecked', 'outputPayloadsVerified', 'outputsUnavailable', 'expiredOutputsRemoved'];
// The original counters remain compatible with older maintenance API consumers.
export const CANONICAL_PRESERVATION_COUNTERS = ['canonicalOperationsChecked', 'canonicalOperationsAdded', 'canonicalEventsChecked', 'canonicalEventsAdded', 'canonicalLegacyBudgetChecked', 'canonicalLegacyBudgetAdded'];

export function canonicalPreservationSummaryValid(report) {
  if (report?.canonicalCoverage === undefined) return report?.baselineScope === undefined && CANONICAL_PRESERVATION_COUNTERS.every(key => report?.[key] === undefined);
  return ['verified', 'not-in-baseline'].includes(report.canonicalCoverage)
    && report.baselineScope === (report.canonicalCoverage === 'verified' ? 'legacy-and-canonical' : 'legacy-only')
    && CANONICAL_PRESERVATION_COUNTERS.every(key => Number.isSafeInteger(report[key]) && report[key] >= 0)
    && (report.canonicalCoverage !== 'not-in-baseline' || CANONICAL_PRESERVATION_COUNTERS.every(key => report[key] === 0));
}

export function baselinePreservationAccepted(report) {
  return report?.comparisonContract === BASELINE_PRESERVATION_CONTRACT && report.baselinePreserved === true
    && canonicalPreservationSummaryValid(report)
    && PRESERVATION_COUNTERS.every(key => Number.isSafeInteger(report[key]) && report[key] >= 0)
    && report.outputsAdded === 0 && report.expiredOutputsRemoved === 0
    && report.outputsChecked === report.outputPayloadsVerified + report.outputsUnavailable
    && report.status === (report.outputsUnavailable ? 'PARTIAL' : 'PASS');
}

function payloadHash(root, id, expectedSize, suffix = '.out', allowTail = false) {
  if (!idPattern.test(id) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxPayload) throw Error('Invalid output payload');
  const name = join(root, id + suffix);
  const before = lstatSync(name, {bigint: true});
  const safe = stat => stat.isFile() && stat.nlink === 1n && (process.platform === 'win32' || (!(stat.mode & 0o077n) && stat.uid === BigInt(process.getuid())));
  if (!safe(before) || before.isSymbolicLink() || (allowTail ? before.size < BigInt(expectedSize) || before.size > BigInt(maxPayload) : before.size !== BigInt(expectedSize))) throw Error('Unsafe output payload');
  const retainedSize = Number(before.size);
  const fd = openSync(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = fstatSync(fd, {bigint: true}), identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':');
    if (!safe(first) || identity(before) !== identity(first)) throw Error('Output payload changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
    let position = 0;
    while (position < retainedSize) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, retainedSize - position), position);
      if (!count) throw Error('Incomplete output payload');
      digest.update(buffer.subarray(0, count)); position += count;
    }
    if (identity(first) !== identity(fstatSync(fd, {bigint: true})) || identity(first) !== identity(lstatSync(name, {bigint: true}))) throw Error('Output payload changed');
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

function requests(rows) {
  const result = Object.create(null);
  for (const row of rows) {
    const body = JSON.parse(row.body);
    if (!idPattern.test(row.id) || body.id !== row.id || !terminal.has(body.state) || Object.hasOwn(result, row.id)) throw Error('Nonterminal or invalid request');
    result[row.id] = rowHash(row);
  }
  return result;
}

function canonicalSnapshot(operationStore, eventPrefixCount) {
  if (!operationStore?.preservationRows || eventPrefixCount !== undefined && (!Number.isSafeInteger(eventPrefixCount) || eventPrefixCount < 0)) throw Error('Canonical preservation context required');
  const rows = operationStore.preservationRows(), operations = [];
  for (const row of rows.operations) {
    if (!terminal.has(row.state) || JSON.parse(row.body).state !== row.state) throw Error('Nonterminal or invalid canonical operation');
    operations.push(rowHash(row));
  }
  const events = createHash('sha256');
  let count = 0, prefixDigest = eventPrefixCount === 0 ? events.copy().digest('hex') : null;
  for (const row of rows.events) {
    events.update(JSON.stringify(row) + '\n'); count++;
    if (count === eventPrefixCount) prefixDigest = events.copy().digest('hex');
  }
  const digest = events.digest('hex');
  return {schema: rowHash(rows.schema), operations, legacyBudget: Array.from(rows.legacyBudget, rowHash),
    events: {count, digest, prefixCount: eventPrefixCount ?? count, prefixDigest: eventPrefixCount === undefined ? digest : prefixDigest}};
}

/** Call synchronously in the service process at an idle, fenced boundary. */
export function capturePreservationSnapshot({commandState, cliState, outputs, operationStore, canonicalEventPrefixCount, legacyOnly = false, now = Date.now()}) {
  if (!Number.isSafeInteger(now) || now <= 0 || !outputs || typeof legacyOnly !== 'boolean' || legacyOnly && (operationStore || canonicalEventPrefixCount !== undefined)) throw Error('Invalid preservation context');
  // Only the explicit pre-canonical offline migration path can create a legacy baseline.
  const canonical = legacyOnly ? null : canonicalSnapshot(operationStore, canonicalEventPrefixCount);
  const command = commandState?.preservationRows() ?? null;
  const cli = cliState?.preservationRows() ?? null;
  const output = outputs.preservationRows(), savedOutputs = Object.create(null);
  for (const row of output.outputs) {
    if (!idPattern.test(row.id) || Object.hasOwn(savedOutputs, row.id) || hash(row.body) !== row.digest) throw Error('Invalid output record');
    const body = JSON.parse(row.body);
    if (body.id !== row.id || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= 0 || !['ready', 'unavailable'].includes(body.state)) throw Error('Pending or invalid output');
    savedOutputs[row.id] = {row: rowHash(row), expiresAt: body.expiresAt,
      payload: body.state === 'ready' ? payloadHash(outputs.root, row.id, body.size) : null,
      ...(body.stream ? {streamPayload: payloadHash(outputs.root, row.id, body.stream.size, '.stream', true)} : {})};
  }
  return {version: legacyOnly ? 1 : 2, observedAt: now, ...(canonical ? {canonical} : {}),
    command: command && {schema: rowHash(command.schema), policy: rowHash(command.policy), requests: requests(command.requests)},
    cli: cli && {schema: rowHash(cli.schema), requests: requests(cli.requests)},
    output: {schema: rowHash(output.schema), rows: savedOutputs}};
}

/** Strictly compare old rows; new rows are counted, never treated as old data. */
export function comparePreservationSnapshots(before, after) {
  if (![1, 2].includes(before?.version) || ![1, 2].includes(after?.version) || before.version === 2 && !before.canonical || after.version === 2 && !after.canonical || !Number.isSafeInteger(before.observedAt) || !Number.isSafeInteger(after.observedAt) || after.observedAt < before.observedAt) throw Error('Invalid preservation snapshots');
  const report = {status: 'PASS', commandRequestsChecked: 0, cliRequestsChecked: 0, outputsChecked: 0, outputPayloadsVerified: 0, outputsUnavailable: 0, expiredOutputsRemoved: 0,
    comparisonContract: BASELINE_PRESERVATION_CONTRACT, baselinePreserved: false, outputsAdded: 0,
    baselineScope: before.canonical ? 'legacy-and-canonical' : 'legacy-only', canonicalCoverage: before.canonical ? 'verified' : 'not-in-baseline',
    ...Object.fromEntries(CANONICAL_PRESERVATION_COUNTERS.map(key => [key, 0]))};
  if (before.canonical) {
    const old = before.canonical, current = after.canonical;
    if (!current || old.schema !== current.schema) throw Error('Canonical schema or presence changed');
    for (const [name, checked, added] of [['operations', 'canonicalOperationsChecked', 'canonicalOperationsAdded'], ['legacyBudget', 'canonicalLegacyBudgetChecked', 'canonicalLegacyBudgetAdded']]) {
      const retained = new Set(current[name]);
      if (retained.size !== current[name].length || new Set(old[name]).size !== old[name].length || old[name].some(digest => !retained.has(digest))) throw Error('Existing canonical record changed or missing');
      report[checked] = old[name].length; report[added] = current[name].length - old[name].length;
    }
    if (!Number.isSafeInteger(old.events.count) || old.events.count < 0 || !Number.isSafeInteger(current.events.count) || current.events.count < old.events.count
      || (current.events.count === old.events.count ? current.events.digest !== old.events.digest : current.events.prefixCount !== old.events.count || current.events.prefixDigest !== old.events.digest)) throw Error('Canonical event prefix changed or missing');
    report.canonicalEventsChecked = old.events.count; report.canonicalEventsAdded = current.events.count - old.events.count;
  }
  for (const [name, counter] of [['command', 'commandRequestsChecked'], ['cli', 'cliRequestsChecked']]) {
    const old = before[name], current = after[name];
    if (old && !current) throw Error('Journal presence changed');
    if (!old) continue;
    if (old.schema !== current.schema || (name === 'command' && old.policy !== current.policy)) throw Error('Journal schema or policy changed');
    for (const [id, digest] of Object.entries(old.requests)) {
      if (current.requests[id] !== digest) throw Error('Existing request changed');
      report[counter]++;
    }
  }
  if (before.output.schema !== after.output.schema) throw Error('Output schema changed');
  for (const [id, old] of Object.entries(before.output.rows)) {
    const current = after.output.rows[id];
    if (!current) {
      if (old.expiresAt > after.observedAt) throw Error('Unexpired output missing');
      report.expiredOutputsRemoved++;
    } else if (old.row !== current.row || old.payload !== current.payload || old.streamPayload !== current.streamPayload || old.expiresAt !== current.expiresAt) throw Error('Existing output changed');
    else if (old.payload === null) report.outputsUnavailable++;
    else report.outputPayloadsVerified++;
    report.outputsChecked++;
  }
  if (report.outputsUnavailable || report.expiredOutputsRemoved) report.status = 'PARTIAL';
  report.outputsAdded = Object.keys(after.output.rows).filter(id => !Object.hasOwn(before.output.rows, id)).length;
  // Unavailable baseline bodies stay unavailable; this is not a claim of full payload availability.
  report.baselinePreserved = report.expiredOutputsRemoved === 0 && report.outputsAdded === 0;
  return report;
}
