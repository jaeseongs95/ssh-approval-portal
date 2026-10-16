import { openSync, fsyncSync, closeSync, writeSync } from 'node:fs';
import { hash } from '../../domain/validation.mjs';

/** Complete partial writes; a zero/invalid write must never count as durable approval. */
export function writeAll(fd, bytes, writer) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writer(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) throw Error('Audit write did not complete');
    offset += n;
  }
}

/**
 * Synchronous durable audit port. Only allowlisted metadata reaches the JSONL file.
 * @param {{path:string,redact:(text:string,options:{entropyScan:boolean})=>string,now?:()=>Date}} options
 * @returns {(event:Object)=>void} Throws before returning if write/fsync fails.
 */
export function createAudit({ path, redact, now = () => new Date() }) {
  return event => {
    const operation = event.operation;
    const record = { at: now().toISOString(), action: event.action, id: event.id, kind: event.kind ?? operation?.kind, profile: event.profile, target: event.target, targetId: event.targetId, targetRevision: event.targetRevision, commandClass: event.commandClass };
    const command = event.command ?? operation?.command;
    if (event.decision) record.decision = event.decision;
    if (event.policyRevision !== undefined) record.policyRevision = event.policyRevision;
    if (command) { record.commandHash = hash(command); record.command = redact(command, { entropyScan: true }); }
    if (operation && operation.kind !== 'command') Object.assign(record, { remotePath: operation.remotePath, sha256: operation.sha256, size: operation.size, overwrite: operation.overwrite, elevate: operation.elevate });
    const fd = openSync(path, 'a', 0o600);
    try { writeAll(fd, Buffer.from(JSON.stringify(record) + '\n'), writeSync); fsyncSync(fd); } finally { closeSync(fd); }
  };
}
