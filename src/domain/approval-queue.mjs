import { randomBytes } from 'node:crypto';
import { EXPIRES_MS } from '../contracts/ports.mjs';
import { hash, validateCommand } from './validation.mjs';

const COMMAND_AUTHORITY = Symbol('server-command-policy');

/** @typedef {import('../contracts/ports.mjs').OperationOutcome} OperationOutcome */
/** @typedef {import('../contracts/ports.mjs').Job} Job */

/** Approval policy and in-process execution claims; transports and durable audit are injected. */
export class ApprovalQueue {
  /**
   * @param {{classify:(command:string)=>{class:string}, executeOperation:(operation:Object,id:string)=>Promise<OperationOutcome>, profile:string, target:string, audit?:(event:Object)=>void, now?:()=>number, idFactory?:()=>string, onTerminal?:(job:Object)=>void, externalBusy?:()=>boolean}} ports
   * audit is synchronous and may throw: a failed admission record never authorizes execution.
   */
  constructor({ classify, executeOperation, profile, target, audit = () => {}, now = () => Date.now(), idFactory = () => randomBytes(24).toString('hex'), onTerminal = () => {}, externalBusy = () => false, identity, claimExecution = () => () => {} }) {
    if (typeof profile !== 'string' || !profile) throw Error('Approval profile is required');
    Object.assign(this, { classify, executeOperation, profile, target, audit, now, idFactory, onTerminal, externalBusy });
    this.identity = identity && Object.freeze({ ...identity }); this.claimExecution = claimExecution;
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
    // Operations contain flat primitives; retain no caller-owned mutable object.
    const op = Object.freeze({ ...operation });
    const job = { id: this.idFactory(), operation: op, profile: this.profile, commandClass,
      ...this.identity, target: this.target, state: 'pending', createdAt: this.now(), expiresAt: this.now() + EXPIRES_MS };
    this.audit({ action: 'submitted', ...this.public(job) });
    this.jobs.set(job.id, job);
    return this.public(job);
  }
  public(job) {
    if (!job) return null;
    return { id: job.id, kind: job.operation.kind, operation: { ...job.operation }, command: job.operation.command,
      ...Object.fromEntries(['targetId', 'targetRevision', 'targetDisplayName', 'hostKey'].filter(key => job[key] !== undefined).map(key => [key, job[key]])),
      ...(job.decision ? { decision: structuredClone(job.decision) } : {}), profile: job.profile, commandClass: job.commandClass, target: job.target, state: job.state,
      createdAt: job.createdAt, expiresAt: job.expiresAt, finishedAt: job.finishedAt, result: job.result, auditError: job.auditError };
  }
  subject(id) {
    const job = this.jobs.get(id); if (!job) throw Error('Unknown request');
    return hash(JSON.stringify({ ...this.identity, id, operation: job.operation, profile: job.profile, target: job.target, expiresAt: job.expiresAt }));
  }
  get(id) {
    const job = this.jobs.get(id);
    if (['pending', 'evaluating'].includes(job?.state) && this.now() >= job.expiresAt) {
      // Expiry is irrevocable even if the audit adapter fails. Callers handle that failure.
      job.state = 'expired'; job.finishedAt = this.now();
      try { job.persist?.(this.public(job)); this.audit({ action: 'expired', id }); } finally { this.onTerminal(job); }
    }
    return this.public(job);
  }
  listAll() { return [...this.jobs.keys()].map(id => this.get(id)); }
  list() { return this.listAll().filter(job => job.state === 'pending'); }
  busy() { return Boolean(this.active) || this.externalBusy(); }
  reserveMaintenance() {
    if (this.maintenance || this.busy() || this.listAll().some(job => ['pending', 'evaluating'].includes(job.state))) throw Error('Requests must finish before maintenance');
    this.audit({ action: 'maintenance-reserved' }); this.maintenance = true;
  }
  releaseMaintenance() { this.audit({ action: 'maintenance-released' }); this.maintenance = false; }
  reap() {
    for (const [id, job] of this.jobs) {
      this.get(id);
      if (!['pending', 'evaluating', 'running'].includes(job.state) && this.now() > (job.finishedAt ?? job.expiresAt) + 3_600_000) this.jobs.delete(id);
    }
  }
  deny(id) {
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') throw Error('Request is not pending');
    this.audit({ action: 'denied', id });
    job.state = 'denied'; job.finishedAt = this.now(); job.persist?.(this.public(job)); this.onTerminal(job); return this.public(job);
  }
  restore(job, persist) { this.jobs.set(job.id, { ...job, operation: Object.freeze({ ...job.operation }), persist }); }
  track(id, persist) { this.jobs.get(id).persist = persist; }
  beginEvaluation(id) { this.jobs.get(id).state = 'evaluating'; }
  abortEvaluation(id) { const job = this.jobs.get(id); job.state = 'unknown'; job.finishedAt = this.now(); }
  setDecision(id, decision) { const job = this.jobs.get(id); job.decision = structuredClone(decision); job.persist?.(this.public(job)); }
  finishEvaluation(id, state = 'pending') {
    const job = this.jobs.get(id);
    if (this.get(id).state !== 'evaluating') throw Error('Request is not evaluating');
    job.state = state;
    if (state !== 'pending') job.finishedAt = this.now();
    job.persist?.(this.public(job));
  }
  startCommand(id) {
    const job = this.jobs.get(id);
    if (job?.operation.kind !== 'command' || job.decision?.decision !== 'execute') throw Error('Command policy authority required');
    return this.start(id, false, COMMAND_AUTHORITY);
  }
  start(id, automatic = false, authority) {
    if (this.maintenance) throw Error('Maintenance in progress');
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') throw Error('Request is not pending');
    if (automatic && (job.operation.kind !== 'download' || job.operation.elevate)) throw Error('Approval required');
    if (this.busy()) throw Error('A request is already executing');
    if (job.operation.kind === 'command') validateCommand(job.operation.command, this.classify);
    if (job.operation.kind === 'command') this.beforeCommandStart?.(this.public(job));
    const release = this.claimExecution();
    try {
      this.audit({ action: authority === COMMAND_AUTHORITY ? 'policy-execution-started' : automatic ? 'read-started' : 'approved', ...this.public(job) });
      job.state = 'running'; job.persist?.(this.public(job));
    } catch (error) { if (job.state === 'running') { job.state = 'unknown'; job.finishedAt = this.now(); } release(); throw error; }
    this.active = job;
    // The claim and audit complete synchronously before any external side effect.
    job.completion = Promise.resolve().then(async () => {
      try {
        job.result = await this.executeOperation(job.operation, job.id);
        job.state = job.result.failed ? 'failed' : 'completed';
      } catch {
        job.result = { failed: true, texts: ['Operation failed; check the protected server diagnostics.'] };
        job.state = 'failed';
      } finally {
        job.finishedAt = this.now();
        try { this.audit({ action: job.state, id }); job.persist?.(this.public(job)); } catch { job.auditError = 'Final audit write failed; operation must not be retried automatically'; }
        this.active = null; try { this.onTerminal(job); } finally { release(); }
      }
      return this.public(job);
    });
    return this.public(job);
  }
  async approve(id) { this.start(id); return this.jobs.get(id).completion; }
  async wait(id) { return this.jobs.get(id)?.completion; }
}
