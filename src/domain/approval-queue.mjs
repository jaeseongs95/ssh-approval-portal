import { randomBytes } from 'node:crypto';
import { APPROVAL_EXPIRES_MS } from '../contracts/ports.mjs';
import { hash, validateCommand } from './validation.mjs';
import { callerContext } from './execution-context.mjs';
import { dispatchStep, dispatchRefusal, dispatchFailureDetails } from './dispatch-failure.mjs';
import { executionFailureDetails } from './execution-failure.mjs';

const COMMAND_AUTHORITY = Symbol('server-command-policy');
const UPLOAD_AUTHORITY = Symbol('server-upload-policy');
const DOWNLOAD_AUTHORITY = Symbol('server-download-policy');
const READ_AUTHORITY = Symbol('server-read-policy');
const TERMINAL = new Set(['completed', 'failed', 'denied', 'expired', 'cancelled', 'unknown']);

/** @typedef {import('../contracts/ports.mjs').OperationOutcome} OperationOutcome */
/** @typedef {import('../contracts/ports.mjs').Job} Job */

/** Approval policy only; one injected durable scheduler owns execution and capacity. */
export class ApprovalQueue {
  /**
   * @param {{classify:(command:string)=>{class:string}, executeOperation:(operation:Object,id:string)=>Promise<OperationOutcome>, profile:string, target:string, requestCapacity?:number, audit?:(event:Object)=>void, now?:()=>number, idFactory?:()=>string, onTerminal?:(job:Object)=>void, operationStore?:Object, scheduler?:Object, submissionIdentity?:()=>Object}} ports
   * audit is synchronous and may throw: a failed admission record never authorizes execution.
   */
  constructor({ classify, executeOperation, profile, readProfile = profile, target, requestCapacity = 100, audit = () => {}, now = () => Date.now(), idFactory = () => randomBytes(24).toString('hex'), onTerminal = () => {}, identity, operationStore, scheduler, submissionIdentity = () => undefined }) {
    if (typeof profile !== 'string' || !profile) throw Error('Approval profile is required');
    if (!Number.isSafeInteger(requestCapacity) || requestCapacity < 1) throw Error('Invalid request capacity');
    Object.assign(this, { classify, executeOperation, profile, readProfile, target, requestCapacity, audit, now, idFactory, onTerminal, operationStore, scheduler, submissionIdentity });
    this.identity = identity && Object.freeze({ ...identity });
    this.jobs = new Map(); this.requestWaiters = new Set(); this.maintenance = false;
  }
  get active() { return [...this.jobs.values()].find(job => job.state === 'running') ?? null; }
  get maintenance() { return this._maintenance ?? false; }
  set maintenance(value) {
    this._maintenance = value;
    if (value && this.jobs) for (const job of this.jobs.values()) if (job.state === 'queued') {
      this.finishBeforeDispatch(job, 'failed', { dispatchFailureReason: 'maintenance', dispatchFailureStage: 'maintenance' });
    }
  }
  submitRead(command, context = '', displayContext = '') {
    if (validateCommand(command, this.classify).class !== 'read-only') throw Error('Read policy authority required');
    context = callerContext(context); displayContext = callerContext(displayContext);
    const job = this.submitOperation({ kind: 'command', command, readOnly: true, ...(context ? { context } : {}), ...(displayContext ? { displayContext } : {}) }, 'read-only');
    return this.start(job.id, false, READ_AUTHORITY);
  }
  submit(command, safeOnly = false, context = '', displayContext = '') {
    const { class: commandClass } = validateCommand(command, this.classify, safeOnly);
    context = callerContext(context); displayContext = callerContext(displayContext);
    return this.submitOperation({ kind: 'command', command, ...(context ? { context } : {}), ...(displayContext ? { displayContext } : {}) }, commandClass);
  }
  submitOperation(operation, commandClass = 'privileged', { expiresAt } = {}) {
    if (this.maintenance) throw Error('Maintenance in progress');
    this.reap();
    if (this.jobs.size >= this.requestCapacity) throw Error('Queue full');
    // Operations contain flat primitives; retain no caller-owned mutable object.
    const op = Object.freeze({ ...operation });
    const createdAt = this.now();
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt || expiresAt > createdAt + APPROVAL_EXPIRES_MS)) throw Error('Invalid approval deadline');
    const submission = this.submissionIdentity();
    const job = { id: submission?.id ?? this.idFactory(), operationKey: submission?.requestKey ?? operation.operationKey, requestOwner: submission?.owner, inputDigest: submission?.inputDigest, operation: op, profile: op.readOnly ? this.readProfile : this.profile, commandClass,
      ...this.identity, target: this.target, state: 'pending', createdAt, expiresAt: expiresAt ?? createdAt + APPROVAL_EXPIRES_MS };
    this.audit({ action: 'submitted', ...this.public(job) });
    // The immutable intent is durable before callers can observe acceptance.
    this.operationStore?.accept(this.operationRecord(job));
    this.jobs.set(job.id, job);
    return this.public(job);
  }
  operationRecord(job) {
    return { id: job.id, requestKey: job.operationKey ?? job.id, owner: job.requestOwner ?? 'approval', ...(job.inputDigest ? { inputDigest: job.inputDigest } : {}), targetId: job.targetId ?? this.target,
      targetRevision: job.targetRevision ?? 'legacy-unbound', kind: job.operation.kind,
      input: { requestId: job.id, operation: { ...job.operation }, profile: job.profile, commandClass: job.commandClass },
      expiresAt: job.expiresAt, createdAt: job.createdAt, metadata: { approval: this.public(job) } };
  }
  public(job) {
    if (!job) return null;
    return { id: job.id, ...(job.operationKey ? { operationKey: job.operationKey } : {}), ...(job.requestOwner ? { requestOwner: job.requestOwner } : {}), ...(job.inputDigest ? { inputDigest: job.inputDigest } : {}), kind: job.operation.kind, operation: { ...job.operation }, command: job.operation.command,
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
    if (job?.state === 'queued' && this.now() >= job.expiresAt) this.finishBeforeDispatch(job, 'expired');
    if (['pending', 'evaluating'].includes(job?.state) && this.now() >= job.expiresAt) {
      // Expiry is irrevocable even if the audit adapter fails. Callers handle that failure.
      this.finishBeforeDispatch(job, 'expired');
    }
    return this.public(job);
  }
  listAll() { return [...this.jobs.keys()].map(id => this.get(id)); }
  list() { return this.listAll().filter(job => job.state === 'pending'); }
  executionBusy() { return [...this.jobs.values()].some(job => job.state === 'running'); }
  busy() { return [...this.jobs.values()].some(job => ['queued', 'running'].includes(job.state)); }
  reserveMaintenance() {
    if (this.maintenance || this.busy() || this.listAll().some(job => ['pending', 'evaluating', 'queued'].includes(job.state))) throw Error('Requests must finish before maintenance');
    this.audit({ action: 'maintenance-reserved' }); this.maintenance = true;
  }
  releaseMaintenance() { this.audit({ action: 'maintenance-released' }); this.maintenance = false; }
  reap() {
    for (const [id, job] of this.jobs) {
      this.get(id);
      if (!['pending', 'evaluating', 'queued', 'running'].includes(job.state) && this.now() > (job.finishedAt ?? job.expiresAt) + 3_600_000) this.jobs.delete(id);
    }
  }
  deny(id) {
    const job = this.jobs.get(id);
    if (!job || !['pending', 'queued'].includes(this.get(id).state)) throw Error('Request is not pending');
    this.audit({ action: 'denied', id });
    return this.finishBeforeDispatch(job, 'denied');
  }
  restore(job, persist) {
    const durable = this.operationStore?.get(job.id);
    const restored = { ...job, operation: Object.freeze({ ...job.operation }), persist };
    // Restart never reconstructs an execution closure or replays a private source plan.
    if (durable && TERMINAL.has(durable.state)) Object.assign(restored, { state: durable.state, result: durable.result ?? job.result, finishedAt: durable.finishedAt });
    else if (['queued', 'running'].includes(job.state)) Object.assign(restored, { state: 'unknown', finishedAt: this.now() });
    this.jobs.set(job.id, restored);
  }
  track(id, persist) { this.jobs.get(id).persist = persist; }
  beginEvaluation(id) { this.jobs.get(id).state = 'evaluating'; }
  abortEvaluation(id) { return this.finishBeforeDispatch(this.jobs.get(id), 'unknown'); }
  persistIntent(job) {
    if (!this.operationStore) return;
    const current = this.operationStore.get(job.id);
    this.operationStore.update(job.id, { metadata: { ...current.metadata, approval: this.public(job) } }, { expectedVersion: current.version });
  }
  setDecision(id, decision) { const job = this.jobs.get(id); job.decision = structuredClone(decision); job.persist?.(this.public(job)); this.persistIntent(job); }
  finishEvaluation(id, state = 'pending') {
    const job = this.jobs.get(id);
    if (this.get(id).state !== 'evaluating') throw Error('Request is not evaluating');
    job.state = state;
    dispatchStep('evaluation_persistence', () => { job.persist?.(this.public(job)); this.persistIntent(job); }, 'persistence_failed');
    if (state !== 'pending') this.finishBeforeDispatch(job, state);
  }
  startCommand(id) {
    const job = this.jobs.get(id);
    if (job?.operation.kind !== 'command' || job.decision?.decision !== 'execute') throw Error('Command policy authority required');
    return this.start(id, false, COMMAND_AUTHORITY);
  }
  startUpload(id) {
    const operation = this.jobs.get(id)?.operation;
    if (operation?.kind !== 'upload') throw Error('Upload policy authority required');
    return this.start(id, false, UPLOAD_AUTHORITY);
  }
  startDownload(id) {
    if (this.jobs.get(id)?.operation.kind !== 'download') throw Error('Download policy authority required');
    return this.start(id, false, DOWNLOAD_AUTHORITY);
  }
  rejectAutomaticDispatch(id, error) {
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending' || (job.decision?.reasonCode !== 'test_server_bypass'
        && !(job.decision?.decision === 'execute' && dispatchFailureDetails(error).dispatchFailureReason === 'queue_full'))) return false;
    this.finishBeforeDispatch(job, 'failed', dispatchFailureDetails(error));
    return true;
  }
  start(id, automatic = false, authority) {
    if (this.maintenance) dispatchRefusal('maintenance', 'maintenance', 'Maintenance in progress');
    const job = this.jobs.get(id);
    if (!job || this.get(id).state !== 'pending') dispatchRefusal('request_state', 'request_state', 'Request is not pending');
    if (automatic) dispatchRefusal('authority', 'authority', 'Server policy authority required');
    this.checkStart(job, authority);
    if (!this.scheduler || !this.operationStore) throw Error('Durable operation scheduler is required');
    job.approvalMode = [COMMAND_AUTHORITY, UPLOAD_AUTHORITY, DOWNLOAD_AUTHORITY, READ_AUTHORITY].includes(authority) ? 'automatic' : 'owner';
    job.state = 'queued';
    try {
      dispatchStep('start_audit', () => this.audit({ action: 'execution-queued', ...this.public(job) }), 'audit_failed');
      dispatchStep('start_persistence', () => {
        job.persist?.(this.public(job));
        const current = this.operationStore.get(id);
        this.operationStore.update(id, { metadata: { ...current.metadata, approval: this.public(job) } }, { expectedState: 'accepted' });
      }, 'persistence_failed');
      try { this.scheduler.enqueue(id); }
      catch (error) {
        if (error.code === 'OPERATION_QUEUE_FULL') dispatchRefusal('queue_full', 'execution_queue', 'Execution queue is full');
        throw error;
      }
    } catch (error) {
      job.state = 'pending'; delete job.approvalMode;
      try { job.persist?.(this.public(job)); } catch { job.auditError = 'Admission rollback could not be persisted'; }
      throw error;
    }
    job.executionAuthority = authority;
    job.completion = new Promise(resolve => { job.resolveCompletion = resolve; });
    this.notifyRequest(job);
    return this.public(job);
  }
  checkStart(job, authority) {
    if (this.maintenance) dispatchRefusal('maintenance', 'maintenance', 'Maintenance in progress');
    if (!['pending', 'queued'].includes(job.state) || this.now() >= job.expiresAt) dispatchRefusal('request_state', 'request_state', 'Request is not executable');
    // Source requests use the exact private-plan guard; the fixed quoted receiver
    // contains a fixed launcher and private stdin, not a caller shell command.
    if (job.operation.kind === 'command' && !job.operation.sourceContract) dispatchStep('command_validation', () => validateCommand(job.operation.command, this.classify), 'invalid_command');
    if (job.operation.sourceContract && !this.beforeCommandStart) dispatchRefusal('private_plan', 'source_plan', 'Source plan verification required');
    if (job.operation.readOnly) {
      if (authority !== READ_AUTHORITY || validateCommand(job.operation.command, this.classify).class !== 'read-only') dispatchRefusal('authority', 'authority', 'Read policy authority required');
    } else if (job.operation.kind === 'command') dispatchStep('command_guard', () => this.beforeCommandStart?.(this.public(job)));
    if (authority === UPLOAD_AUTHORITY || authority === DOWNLOAD_AUTHORITY) {
      const decision = dispatchStep('file_guard', () => (authority === UPLOAD_AUTHORITY ? this.beforeUploadStart : this.beforeDownloadStart)?.(this.public(job)));
      if (!decision || decision.decision !== 'execute') dispatchRefusal('authority', 'file_guard', 'File policy authority required');
      dispatchStep('decision_persistence', () => this.setDecision(job.id, decision), 'persistence_failed');
    }
  }
  finishBeforeDispatch(job, state, details) {
    const durable = this.operationStore?.get(job.id);
    if (durable && !['accepted', 'queued'].includes(durable.state)) {
      // A scheduler claim wins cancellation/expiry; its dispatch guard settles the result.
      if (!TERMINAL.has(durable.state)) return this.public(job);
      return this.syncOperation(durable);
    }
    const result = details ? { failed: true, texts: ['Operation was refused before dispatch.'],
      execution: { phase: 'settled', reason: 'input_failed', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false } } : undefined;
    const previousDecision = job.decision, previousResult = job.result;
    if (details) { job.decision = { ...job.decision, dispatchFailure: 'not_dispatched', ...details }; job.result = result; }
    try {
      if (durable) {
        const transition = this.scheduler?.transition ?? this.operationStore.update;
        transition(job.id, { state, ...(result ? { result } : {}), outcomeCertainty: 'not_dispatched' }, { expectedVersion: durable.version });
      }
    } catch (error) { job.decision = previousDecision; job.result = previousResult; throw error; }
    job.state = state; job.finishedAt ??= this.now();
    if (!job.terminalNotified) this.finishTerminal(job);
    return this.public(job);
  }
  finishTerminal(job, { persist = true } = {}) {
    try { if (persist) { this.persistIntent(job); job.persist?.(this.public(job)); this.audit({ action: job.state, id: job.id, failure: job.result?.failure }); } }
    catch { job.auditError = 'Final audit write failed; operation must not be retried automatically'; }
    finally {
      try { if (!job.terminalNotified) { job.terminalNotified = true; this.onTerminal(job); } }
      finally { this.notifyRequest(job); job.resolveCompletion?.(this.public(job)); }
    }
  }
  syncOperation(record, { restoring = false } = {}) {
    const job = this.jobs.get(record.id);
    if (!job) return null;
    if (TERMINAL.has(record.state) && !job.terminalNotified) {
      job.state = record.state; job.finishedAt = record.finishedAt ?? this.now(); job.result = record.result ?? job.result;
      // Startup restores an already durable outcome; cleanup still runs once.
      this.finishTerminal(job, { persist: !restoring });
    }
    return this.public(job);
  }
  async awaitOperation(id) {
    let record = this.scheduler.get(id);
    while (record && !TERMINAL.has(record.state)) record = await this.scheduler.observe(id, { timeoutMs: 60000 });
    if (record) this.syncOperation(record);
    return this.get(id);
  }
  async executeScheduled(id, options = {}) {
    const job = this.jobs.get(id);
    if (!job) throw Error('Unknown approval request; never replay');
    try {
      this.checkStart(job, job.executionAuthority);
      dispatchStep('start_audit', () => this.audit({ action: job.approvalMode === 'automatic' ? 'policy-execution-started' : 'approved', ...this.public(job) }), 'audit_failed');
      job.state = 'running';
      dispatchStep('start_persistence', () => job.persist?.(this.public(job)), 'persistence_failed');
      this.notifyRequest(job);
    } catch (error) {
      job.decision = { ...job.decision, dispatchFailure: 'not_dispatched', ...dispatchFailureDetails(error) };
      return { failed: true, texts: ['Execution was refused before dispatch.'],
        execution: { phase: 'settled', reason: 'input_failed', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false } };
    }
    try { return await this.executeOperation(job.operation, job.id, options); }
    catch (error) {
      const failure = executionFailureDetails(error);
      const refusal = dispatchFailureDetails(error);
      const notStarted = refusal.dispatchFailureStage !== 'unknown' || failure.remoteOutcome === 'not_started';
      if (notStarted) job.decision = { ...job.decision, dispatchFailure: 'not_dispatched', ...refusal };
      return { failed: true, texts: [`Operation failed (${failure.code}, ${failure.stage}); do not replay automatically.`], failure,
        execution: notStarted
          ? { phase: 'settled', reason: 'input_failed', remoteState: 'not_dispatched', cleanupComplete: true, requiresReconciliation: false }
          : { phase: 'settled', reason: 'transport_lost', remoteState: 'unknown', cleanupComplete: false, requiresReconciliation: true } };
    }
  }
  async drain() { await Promise.all([...this.jobs.values()].filter(job => ['queued', 'running'].includes(job.state)).map(job => job.completion ?? this.awaitOperation(job.id))); }
  // Read-only event subscriptions: no execution claims, network targets or replay.
  waitForRequest(id, { until = 'approval', timeoutMs = 25000, signal } = {}) {
    if (!['approval', 'completion'].includes(until) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Invalid request wait');
    signal?.throwIfAborted();
    const current = this.get(id);
    const eventFor = job => !job ? 'missing' : ['pending', 'evaluating'].includes(job.state) ? null
      : ['queued', 'running'].includes(job.state) ? until === 'approval' && ['owner', 'automatic'].includes(job.approvalMode) ? 'approved' : null : job.state;
    const event = eventFor(current);
    if (event) return Promise.resolve({ job: current, event, until });
    // ponytail: bounded per-target subscriptions; a shared broker is unnecessary for one bridge process.
    if (this.requestWaiters.size >= 64) throw Error('Request wait limit reached');
    return new Promise((resolve, reject) => {
      let timer, expiryTimer;
      const finish = (job, event, error) => {
        if (!this.requestWaiters.delete(waiter)) return;
        clearTimeout(timer); clearTimeout(expiryTimer); signal?.removeEventListener('abort', abort);
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
      const checkExpiry = () => {
        try {
          const job = this.get(id), event = eventFor(job);
          if (event) { finish(job, event); return; }
          // An expiry wake may precede the wall-clock boundary. It is not the
          // caller's timeout; recheck expiry while the independent wait runs.
          if (['pending', 'evaluating', 'queued'].includes(job.state)) {
            expiryTimer = setTimeout(checkExpiry, Math.max(1, job.expiresAt - this.now()));
          }
        } catch (error) { finish(null, null, error); }
      };
      timer = setTimeout(expireWait, timeoutMs);
      if (['pending', 'evaluating', 'queued'].includes(current.state) && current.expiresAt - this.now() < timeoutMs) {
        expiryTimer = setTimeout(checkExpiry, Math.max(1, current.expiresAt - this.now()));
      }
    });
  }
  notifyRequest(job) {
    const snapshot = this.public(job);
    for (const waiter of this.requestWaiters) if (waiter.id === job.id) waiter.notify(snapshot);
  }
  async approve(id) { this.start(id); return this.jobs.get(id).completion; }
  async wait(id) { const job = this.jobs.get(id); return job?.completion ?? (job && TERMINAL.has(job.state) ? this.public(job) : undefined); }
}
