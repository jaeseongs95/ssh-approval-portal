import { randomBytes } from 'node:crypto';
import { APPROVAL_EXPIRES_MS } from '../contracts/ports.mjs';
import { hash, validateCommand } from './validation.mjs';
import { callerContext } from './execution-context.mjs';

const COMMAND_AUTHORITY = Symbol('server-command-policy');
const UPLOAD_AUTHORITY = Symbol('server-upload-policy');
const DOWNLOAD_AUTHORITY = Symbol('server-download-policy');

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
    this.requestWaiters = new Set();
  }
  submit(command, safeOnly = false, context = '', displayContext = '') {
    const { class: commandClass } = validateCommand(command, this.classify, safeOnly);
    context = callerContext(context); displayContext = callerContext(displayContext);
    return this.submitOperation({ kind: 'command', command, ...(context ? { context } : {}), ...(displayContext ? { displayContext } : {}) }, commandClass);
  }
  submitOperation(operation, commandClass = 'privileged', { expiresAt } = {}) {
    if (this.maintenance) throw Error('Maintenance in progress');
    this.reap();
    if (this.jobs.size >= 100) throw Error('Queue full');
    // Operations contain flat primitives; retain no caller-owned mutable object.
    const op = Object.freeze({ ...operation });
    const createdAt = this.now();
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt || expiresAt > createdAt + APPROVAL_EXPIRES_MS)) throw Error('Invalid approval deadline');
    const job = { id: this.idFactory(), operation: op, profile: this.profile, commandClass,
      ...this.identity, target: this.target, state: 'pending', createdAt, expiresAt: expiresAt ?? createdAt + APPROVAL_EXPIRES_MS };
    this.audit({ action: 'submitted', ...this.public(job) });
    this.jobs.set(job.id, job);
    return this.public(job);
  }
  public(job) {
    if (!job) return null;
    return { id: job.id, kind: job.operation.kind, operation: { ...job.operation }, command: job.operation.command,
      ...Object.fromEntries(['targetId', 'targetRevision', 'targetDisplayName', 'hostKey'].filter(key => job[key] !== undefined).map(key => [key, job[key]])),
      ...(job.decision ? { decision: structuredClone(job.decision) } : {}), profile: job.profile, commandClass: job.commandClass, target: job.target, state: job.state,
      ...(job.approvalMode ? { approvalMode: job.approvalMode } : {}),
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
      try { job.persist?.(this.public(job)); this.audit({ action: 'expired', id }); } finally { try { this.onTerminal(job); } finally { this.notifyRequest(job); } }
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
    job.state = 'denied'; job.finishedAt = this.now(); try { job.persist?.(this.public(job)); } finally { try { this.onTerminal(job); } finally { this.notifyRequest(job); } } return this.public(job);
  }
  restore(job, persist) { this.jobs.set(job.id, { ...job, operation: Object.freeze({ ...job.operation }), persist }); }
  track(id, persist) { this.jobs.get(id).persist = persist; }
  beginEvaluation(id) { this.jobs.get(id).state = 'evaluating'; }
  abortEvaluation(id) { const job = this.jobs.get(id); job.state = 'unknown'; job.finishedAt = this.now(); try { this.onTerminal(job); } finally { this.notifyRequest(job); } }
  setDecision(id, decision) { const job = this.jobs.get(id); job.decision = structuredClone(decision); job.persist?.(this.public(job)); }
  finishEvaluation(id, state = 'pending') {
    const job = this.jobs.get(id);
    if (this.get(id).state !== 'evaluating') throw Error('Request is not evaluating');
    job.state = state;
    if (state !== 'pending') job.finishedAt = this.now();
    try { job.persist?.(this.public(job)); } finally { if (state !== 'pending') { try { this.onTerminal(job); } finally { this.notifyRequest(job); } } }
  }
  startCommand(id) {
    const job = this.jobs.get(id);
    if (job?.operation.kind !== 'command' || job.decision?.decision !== 'execute') throw Error('Command policy authority required');
    return this.start(id, false, COMMAND_AUTHORITY);
  }
  startUpload(id) {
    const operation = this.jobs.get(id)?.operation;
    if (operation?.kind !== 'upload' || operation.elevate !== false || operation.overwrite !== false) throw Error('Owner upload approval required');
    return this.start(id, false, UPLOAD_AUTHORITY);
  }
  startDownload(id) {
    if (this.jobs.get(id)?.operation.kind !== 'download') throw Error('Download policy authority required');
    return this.start(id, false, DOWNLOAD_AUTHORITY);
  }
  start(id, automatic = false, authority) {
    if (this.maintenance) throw Error('Maintenance in progress');
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') throw Error('Request is not pending');
    if (automatic) throw Error('Server policy authority required');
    if (this.busy()) throw Error('A request is already executing');
    // Source requests use the exact private-plan guard; the fixed quoted receiver
    // contains newlines that the legacy string-command boundary rightly rejects.
    if (job.operation.kind === 'command' && !job.operation.sourceContract) validateCommand(job.operation.command, this.classify);
    if (job.operation.sourceContract && !this.beforeCommandStart) throw Error('Source plan verification required');
    if (job.operation.kind === 'command') this.beforeCommandStart?.(this.public(job));
    if (authority === UPLOAD_AUTHORITY || authority === DOWNLOAD_AUTHORITY) {
      const decision = (authority === UPLOAD_AUTHORITY ? this.beforeUploadStart : this.beforeDownloadStart)?.(this.public(job));
      if (!decision || decision.decision !== 'execute') throw Error('File policy authority required');
      this.setDecision(id, decision);
    }
    const release = this.claimExecution();
    const policyAuthority = authority === COMMAND_AUTHORITY || authority === UPLOAD_AUTHORITY || authority === DOWNLOAD_AUTHORITY;
    const approvalMode = policyAuthority || automatic ? 'automatic' : 'owner';
    try {
      this.audit({ action: policyAuthority ? 'policy-execution-started' : automatic ? 'read-started' : 'approved', ...this.public(job), approvalMode });
      job.approvalMode = approvalMode; job.state = 'running'; job.persist?.(this.public(job));
    } catch (error) {
      delete job.approvalMode;
      try { if (job.state === 'running') { job.state = 'unknown'; job.finishedAt = this.now(); try { this.onTerminal(job); } finally { this.notifyRequest(job); } } }
      finally { release(); }
      throw error;
    }
    this.active = job;
    this.notifyRequest(job);
    // The claim and audit complete synchronously before any external side effect.
    job.completion = Promise.resolve().then(async () => {
      try {
        job.result = await this.executeOperation(job.operation, job.id);
        job.state = job.result.failed ? 'failed' : 'completed';
      } catch {
        job.result = { failed: true, texts: ['Operation failed; check the protected server diagnostics.'] };
        job.state = job.operation.sourceContract ? 'unknown' : 'failed';
      } finally {
        job.finishedAt = this.now();
        try { this.audit({ action: job.state, id }); job.persist?.(this.public(job)); } catch { job.auditError = 'Final audit write failed; operation must not be retried automatically'; }
        this.active = null; try { this.onTerminal(job); } finally { try { release(); } finally { this.notifyRequest(job); } }
      }
      return this.public(job);
    });
    return this.public(job);
  }
  // Read-only event subscriptions: no execution claims, network targets or replay.
  waitForRequest(id, { until = 'approval', timeoutMs = 25000, signal } = {}) {
    if (!['approval', 'completion'].includes(until) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Invalid request wait');
    signal?.throwIfAborted();
    const current = this.get(id);
    const eventFor = job => !job ? 'missing' : ['pending', 'evaluating'].includes(job.state) ? null
      : job.state === 'running' ? until === 'approval' && ['owner', 'automatic'].includes(job.approvalMode) ? 'approved' : null : job.state;
    const event = eventFor(current);
    if (event) return Promise.resolve({ job: current, event, until });
    // ponytail: bounded per-target subscriptions; a shared broker is unnecessary for one bridge process.
    if (this.requestWaiters.size >= 64) throw Error('Request wait limit reached');
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (job, event, error) => {
        if (!this.requestWaiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ job, event, until });
      };
      const abort = () => finish(null, null, signal.reason ?? Error('Request wait aborted'));
      const waiter = { id, notify: job => { const event = eventFor(job); if (event) finish(job, event); } };
      // No await between the initial state read and registration: no transition can be lost.
      this.requestWaiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      const expireWait = () => {
        try {
          const job = this.get(id);
          finish(job, eventFor(job) ?? 'timeout');
        } catch (error) { finish(null, null, error); }
      };
      const approvalRemaining = ['pending', 'evaluating'].includes(current.state) ? Math.max(1, current.expiresAt - this.now()) : timeoutMs;
      timer = setTimeout(expireWait, Math.min(timeoutMs, approvalRemaining));
    });
  }
  notifyRequest(job) {
    const snapshot = this.public(job);
    for (const waiter of this.requestWaiters) if (waiter.id === job.id) waiter.notify(snapshot);
  }
  async approve(id) { this.start(id); return this.jobs.get(id).completion; }
  async wait(id) { return this.jobs.get(id)?.completion; }
}
