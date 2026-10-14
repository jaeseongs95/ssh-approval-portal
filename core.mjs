import { randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

export const EXPIRES_MS = 600_000;
export const PROFILE = 'aws-local';
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const idValid = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function writeAll(fd, bytes, writer) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writer(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) throw Error('Audit write did not complete');
    offset += n;
  }
}
export function validateCommand(command, classify, safeOnly = false) {
  if (typeof command !== 'string' || !command.trim() || command.length > 2000 || HIDDEN.test(command)) throw Error('Invalid command');
  const result = classify(command);
  if (safeOnly && result.class !== 'safe') throw Error('Only safe-class commands are supported');
  return result;
}
export function remotePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.length > 4096 || path !== path.trim() || HIDDEN.test(path) || path.split('/').some(p => p === '..' || p === '.')) throw Error('Use an absolute regular-file path without dot segments or hidden characters');
  return path;
}
export class Tickets {
  constructor(key, now = () => Date.now()) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw Error('UI ticket key must be 32 bytes encoded as hex');
    this.key = key; this.now = now;
  }
  issue(purpose, subject, expiresAt) {
    const body = Buffer.from(JSON.stringify({ purpose, subject, expiresAt })).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }
  verify(ticket, purpose, subject) {
    if (typeof ticket !== 'string' || ticket.length > 8192) throw Error('Invalid ticket');
    const [body, signature, extra] = ticket.split('.');
    const expected = createHmac('sha256', this.key).update(body ?? '').digest('base64url');
    if (extra || !equalSecret(signature, expected)) throw Error('Invalid ticket');
    let value; try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw Error('Invalid ticket'); }
    if (value.purpose !== purpose || value.subject !== subject || !Number.isSafeInteger(value.expiresAt) || this.now() >= value.expiresAt) throw Error('Expired or mismatched ticket');
    return value;
  }
}
export async function routeCommand(command, classify, read, queue) {
  return validateCommand(command, classify).class === 'read-only' ? read(command) : queue.submit(command);
}
export class ApprovalQueue {
  constructor({ classify, execute, executeOperation, target, audit = () => {}, now = () => Date.now(), onTerminal = () => {}, externalBusy = () => false }) {
    Object.assign(this, { classify, execute, executeOperation, target, audit, now, onTerminal, externalBusy });
    this.jobs = new Map(); this.active = null; this.maintenance = false;
  }
  submit(command, safeOnly = false) {
    const { class: commandClass } = validateCommand(command, this.classify, safeOnly);
    return this.submitOperation({ kind: 'command', command }, commandClass);
  }
  submitOperation(operation, commandClass = 'privileged') {
    if (this.maintenance) throw Error('Maintenance in progress');
    this.reap();
    if (this.jobs.size >= 100) throw Error('Queue full');
    // Operation values are flat primitives; never retain the caller's mutable object.
    const op = Object.freeze({ ...operation });
    const job = { id: randomBytes(24).toString('hex'), operation: op, profile: PROFILE, commandClass,
      target: this.target, state: 'pending', createdAt: this.now(), expiresAt: this.now() + EXPIRES_MS };
    this.audit({ action: 'submitted', ...this.public(job) });
    this.jobs.set(job.id, job);
    return this.public(job);
  }
  public(job) {
    if (!job) return null;
    return { id: job.id, kind: job.operation.kind, operation: { ...job.operation }, command: job.operation.command,
      profile: job.profile, commandClass: job.commandClass, target: job.target, state: job.state,
      createdAt: job.createdAt, expiresAt: job.expiresAt, finishedAt: job.finishedAt, result: job.result, auditError: job.auditError };
  }
  subject(id) {
    const job = this.jobs.get(id); if (!job) throw Error('Unknown request');
    return hash(JSON.stringify({ id, operation: job.operation, profile: job.profile, target: job.target, expiresAt: job.expiresAt }));
  }
  get(id) {
    const job = this.jobs.get(id);
    if (job?.state === 'pending' && this.now() >= job.expiresAt) {
      job.state = 'expired';
      job.finishedAt = this.now();
      try { this.audit({ action: 'expired', id }); } finally { this.onTerminal(job); }
    }
    return this.public(job);
  }
  list() { return [...this.jobs.keys()].map(id => this.get(id)).filter(j => j.state === 'pending'); }
  busy() { return Boolean(this.active) || this.externalBusy(); }
  reserveMaintenance() {
    if (this.maintenance || this.busy() || this.list().length) throw Error('Requests must finish before maintenance');
    this.audit({ action: 'maintenance-reserved' }); this.maintenance = true;
  }
  releaseMaintenance() { this.audit({ action: 'maintenance-released' }); this.maintenance = false; }
  reap() {
    for (const [id, job] of this.jobs) {
      this.get(id);
      if (!['pending', 'running'].includes(job.state) && this.now() > (job.finishedAt ?? job.expiresAt) + 3_600_000) this.jobs.delete(id);
    }
  }
  deny(id) {
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') throw Error('Request is not pending');
    this.audit({ action: 'denied', id });
    job.state = 'denied'; job.finishedAt = this.now(); this.onTerminal(job); return this.public(job);
  }
  start(id, automatic = false) {
    if (this.maintenance) throw Error('Maintenance in progress');
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') throw Error('Request is not pending');
    if (automatic && (job.operation.kind !== 'download' || job.operation.elevate)) throw Error('Approval required');
    if (this.busy()) throw Error('A request is already executing');
    if (job.operation.kind === 'command') validateCommand(job.operation.command, this.classify);
    this.audit({ action: automatic ? 'read-started' : 'approved', ...this.public(job) });
    job.state = 'running'; this.active = job;
    // Reservation and audit happen synchronously before scheduling any side effect.
    job.completion = Promise.resolve().then(async () => {
      try {
        job.result = this.executeOperation ? await this.executeOperation(job.operation, job.id) : await this.execute(job.operation.command);
        job.state = job.result?.isError ? 'failed' : 'completed';
      } catch {
        // No raw transport exception: it may include file bytes, credentials or commands.
        job.result = { isError: true, content: [{ type: 'text', text: 'Operation failed; check the protected server diagnostics.' }] };
        job.state = 'failed';
      } finally {
        job.finishedAt = this.now();
        try { this.audit({ action: job.state, id }); } catch { job.auditError = 'Final audit write failed; operation must not be retried automatically'; }
        this.active = null; this.onTerminal(job);
      }
      return this.public(job);
    });
    return this.public(job);
  }
  async approve(id) { this.start(id); return this.jobs.get(id).completion; }
  async wait(id) { return this.jobs.get(id)?.completion; }
}
