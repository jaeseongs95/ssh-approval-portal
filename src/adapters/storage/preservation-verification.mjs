import {createHash} from 'node:crypto';
import {constants, closeSync, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {join} from 'node:path';

// Internal values are sensitive evidence. Callers must not return or log snapshots.
const hash = value => createHash('sha256').update(value).digest('hex');
const rowHash = row => hash(JSON.stringify(row));
const terminal = new Set(['completed', 'failed', 'denied', 'expired', 'unknown']);
const idPattern = /^[a-f0-9]{48}$/;
const maxPayload = 16 * 1024 * 1024;
export const BASELINE_PRESERVATION_CONTRACT = 'baseline-preservation-v1';
export const PRESERVATION_COUNTERS = ['commandRequestsChecked', 'cliRequestsChecked', 'outputsChecked', 'outputPayloadsVerified', 'outputsUnavailable', 'expiredOutputsRemoved'];

export function baselinePreservationAccepted(report) {
  return report?.comparisonContract === BASELINE_PRESERVATION_CONTRACT && report.baselinePreserved === true
    && PRESERVATION_COUNTERS.every(key => Number.isSafeInteger(report[key]) && report[key] >= 0)
    && report.outputsAdded === 0 && report.expiredOutputsRemoved === 0
    && report.outputsChecked === report.outputPayloadsVerified + report.outputsUnavailable
    && report.status === (report.outputsUnavailable ? 'PARTIAL' : 'PASS');
}

function payloadHash(root, id, expectedSize) {
  if (!idPattern.test(id) || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxPayload) throw Error('Invalid output payload');
  const name = join(root, id + '.out');
  const before = lstatSync(name, {bigint: true});
  const safe = stat => stat.isFile() && stat.nlink === 1n && (process.platform === 'win32' || (!(stat.mode & 0o077n) && stat.uid === BigInt(process.getuid())));
  if (!safe(before) || before.isSymbolicLink() || before.size !== BigInt(expectedSize)) throw Error('Unsafe output payload');
  const fd = openSync(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const first = fstatSync(fd, {bigint: true}), identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':');
    if (!safe(first) || identity(before) !== identity(first)) throw Error('Output payload changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
    let position = 0;
    while (position < expectedSize) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, expectedSize - position), position);
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

/** Call synchronously in the service process at an idle, fenced boundary. */
export function capturePreservationSnapshot({commandState, cliState, outputs, now = Date.now()}) {
  if (!Number.isSafeInteger(now) || now <= 0 || !outputs) throw Error('Invalid preservation context');
  const command = commandState?.preservationRows() ?? null;
  const cli = cliState?.preservationRows() ?? null;
  const output = outputs.preservationRows(), savedOutputs = Object.create(null);
  for (const row of output.outputs) {
    if (!idPattern.test(row.id) || Object.hasOwn(savedOutputs, row.id) || hash(row.body) !== row.digest) throw Error('Invalid output record');
    const body = JSON.parse(row.body);
    if (body.id !== row.id || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= 0 || !['ready', 'unavailable'].includes(body.state)) throw Error('Pending or invalid output');
    savedOutputs[row.id] = {row: rowHash(row), expiresAt: body.expiresAt,
      payload: body.state === 'ready' ? payloadHash(outputs.root, row.id, body.size) : null};
  }
  return {version: 1, observedAt: now,
    command: command && {schema: rowHash(command.schema), policy: rowHash(command.policy), requests: requests(command.requests)},
    cli: cli && {schema: rowHash(cli.schema), requests: requests(cli.requests)},
    output: {schema: rowHash(output.schema), rows: savedOutputs}};
}

/** Strictly compare old rows; new rows are counted, never treated as old data. */
export function comparePreservationSnapshots(before, after) {
  if (before?.version !== 1 || after?.version !== 1 || !Number.isSafeInteger(before.observedAt) || !Number.isSafeInteger(after.observedAt) || after.observedAt < before.observedAt) throw Error('Invalid preservation snapshots');
  const report = {status: 'PASS', commandRequestsChecked: 0, cliRequestsChecked: 0, outputsChecked: 0, outputPayloadsVerified: 0, outputsUnavailable: 0, expiredOutputsRemoved: 0,
    comparisonContract: BASELINE_PRESERVATION_CONTRACT, baselinePreserved: false, outputsAdded: 0};
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
    } else if (old.row !== current.row || old.payload !== current.payload || old.expiresAt !== current.expiresAt) throw Error('Existing output changed');
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
