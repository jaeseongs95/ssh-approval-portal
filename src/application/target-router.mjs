import { fileTargetBinding, fileTargetFields } from '../domain/file-target-binding.mjs';
import { platformOf, targetCapabilities } from '../domain/target-platform.mjs';

/** Single-process synchronous claims; callers release in finally, with bounded waiting reservations and release notifications. */
export function createClaims(limit, { maxWaiting = 32, onSubscriberError = () => {} } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting < 0) {
    throw new RangeError('Invalid execution claim limits');
  }
  if (typeof onSubscriberError !== 'function') throw new TypeError('Invalid execution claim error handler');
  let used = 0, waiting = 0, scheduled = false;
  const subscribers = new Set();
  const notify = () => {
    if (scheduled || !subscribers.size) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const listener of [...subscribers]) {
        if (!subscribers.has(listener)) continue;
        try { listener.callback(); }
        catch (error) {
          // The caller owns safe error reporting; observer failures cannot stop other queues.
          try { onSubscriberError(error); } catch { /* No reporting failure may consume a wakeup. */ }
        }
      }
    });
  };
  const claim = () => {
    if (used >= limit) throw Error('Global concurrency limit reached');
    used++;
    let released = false;
    return () => { if (!released) { released = true; used--; notify(); } };
  };
  claim.busy = () => used >= limit;
  claim.reserveWait = () => {
    if (waiting >= maxWaiting) throw Object.assign(Error('Execution queue is full'), { code: 'EXECUTION_QUEUE_FULL' });
    waiting++;
    let released = false;
    return () => { if (!released) { released = true; waiting--; notify(); } };
  };
  claim.waiting = () => waiting;
  claim.subscribe = callback => {
    if (typeof callback !== 'function') throw new TypeError('Invalid execution claim subscriber');
    const listener = { callback };
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  };
  return claim;
}

/** Routing and process-wide maintenance; target services retain all approval/file policy. */
export function createTargetRouter(runtimes, { defaultTarget, legacy, store, audit }) {
  const byId = new Map(runtimes.map(runtime => [runtime.id, runtime]));
  const select = id => {
    const target = byId.get(id === undefined ? defaultTarget : id);
    if (!target || !target.enabled) throw Error('Select a registered enabled target');
    return target;
  };
  const jobOwner = id => {
    const owners = runtimes.filter(runtime => runtime.queue.jobs.has(id));
    if (!owners.length) throw Error('Unknown request');
    if (owners.length !== 1) throw Error('Ambiguous request');
    return owners[0];
  };
  const artifactOwner = id => {
    const item = store.get(id);
    if (item.fileTargetBound === true) fileTargetFields(item);
    const runtime = select(item.targetId ?? (legacy ? 'default' : undefined));
    if ((!legacy || item.fileTargetBound === true) && item.targetRevision !== runtime.revision) throw Error('Stale artifact');
    if (item.fileTargetBound === true) runtime.verify();
    return runtime;
  };
  const agentUploadOwner = id => {
    const owners = runtimes.filter(runtime => runtime.queue.listAll().some(job => job.kind === 'upload' && job.operation.artifactId === id && job.operation.uploadProtocol === 'mcp-json-v1'));
    if (!owners.length) return artifactOwner(id);
    if (owners.length !== 1) throw Error('Ambiguous MCP upload owner');
    const runtime = select(owners[0].id);
    const jobs = runtime.queue.listAll().filter(job => job.kind === 'upload' && job.operation.artifactId === id && job.operation.uploadProtocol === 'mcp-json-v1');
    if (jobs.length !== 1) throw Error('Ambiguous MCP upload request');
    const job = jobs[0], binding = fileTargetBinding(job.operation);
    if (!binding || binding.targetId !== runtime.id || binding.targetRevision !== runtime.revision ||
        (job.targetId !== undefined && (job.targetId !== runtime.id || job.targetRevision !== runtime.revision))) throw Error('Stale MCP upload target');
    runtime.verify();
    return runtime;
  };
  const fileAdmission = args => {
    const { expectedTargetRevision, ...payload } = args, runtime = select(payload.target);
    if (expectedTargetRevision === undefined) return { runtime, payload };
    if (payload.target === undefined || typeof expectedTargetRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedTargetRevision) ||
        expectedTargetRevision !== runtime.revision) throw Error('Stale or invalid file target');
    runtime.verify();
    return { runtime, payload, binding: Object.freeze({ targetId: runtime.id, targetRevision: runtime.revision }) };
  };
  let maintenance = false;
  const queue = {
    get jobs() { return legacy ? runtimes[0].queue.jobs : new Map(runtimes.flatMap(runtime => [...runtime.queue.jobs])); },
    get active() { return runtimes.find(runtime => runtime.queue.active)?.queue.active ?? null; },
    get maintenance() { return maintenance; },
    set maintenance(value) { maintenance = value; for (const runtime of runtimes) runtime.queue.maintenance = value; },
    get(id) { try { return jobOwner(id).queue.get(id); } catch (error) { if (!runtimes.some(runtime => runtime.queue.jobs.has(id))) return null; throw error; } },
    subject: id => jobOwner(id).queue.subject(id),
    submit: (command, safeOnly, target) => select(target).queue.submit(command, safeOnly),
    submitOperation: (operation, commandClass, target) => select(target).queue.submitOperation(operation, commandClass),
    start: (id, automatic) => jobOwner(id).queue.start(id, automatic),
    deny: id => jobOwner(id).queue.deny(id),
    approve: id => jobOwner(id).queue.approve(id),
    wait: id => jobOwner(id).queue.wait(id),
    waitForRequest: (id, options) => {
      try { return jobOwner(id).queue.waitForRequest(id, options); }
      catch (error) { if (!runtimes.some(runtime => runtime.queue.jobs.has(id))) return Promise.resolve({ job: null, event: 'missing', until: options?.until ?? 'approval' }); throw error; }
    },
    listAll: () => runtimes.flatMap(runtime => runtime.queue.listAll()),
    list: () => runtimes.flatMap(runtime => runtime.queue.list()),
    busy: () => runtimes.some(runtime => runtime.queue.busy()),
    reap() { let failure; for (const runtime of runtimes) { try { runtime.queue.reap(); } catch (error) { failure ??= error; } } if (failure) throw failure; },
    reserveMaintenance() {
      if (maintenance || runtimes.some(runtime => runtime.commands.busy() || runtime.files.busy() || runtime.queue.busy() || runtime.queue.listAll().some(job => ['pending', 'evaluating', 'queued'].includes(job.state))) || store.hasActiveWork()) throw Error('All targets must finish before maintenance');
      audit({ action: 'maintenance-reserved' }); queue.maintenance = true;
    },
    releaseMaintenance() { audit({ action: 'maintenance-released' }); queue.maintenance = false; },
  };
  return {
    legacy, select, jobOwner, artifactOwner, queue,
    list: () => ({ targets: runtimes.map(runtime => ({ id: runtime.id, displayName: runtime.displayName, enabled: runtime.enabled, revision: runtime.revision, isDefault: runtime.id === defaultTarget,
      platform: platformOf(runtime), capabilities: { ...targetCapabilities(runtime), desktop: runtime.desktop?.enabled === true } })), defaultTarget: defaultTarget ?? null }),
    async listFilePolicies() {
      const listed = this.list();
      return { ...listed, targets: await Promise.all(listed.targets.map(async item => {
        const runtime = byId.get(item.id);
        return typeof runtime.filePolicy === 'function' ? { ...item, filePolicy: await runtime.filePolicy() } : item;
      })) };
    },
    canonicalTransfer(args) { const runtime = select(args.target); return legacy && args.target === undefined ? args : { ...args, target: runtime.id }; },
    commands: { read: (command, target) => select(target).commands.read(command), run: (command, target, requestKey, context, displayContext) => select(target).commands.run(command, requestKey, context, displayContext),
      runSource: (args, target) => select(target).commands.runSource(args), source: id => { const runtime = jobOwner(id); select(runtime.id).verify(); return runtime.commands.source(id); },
      busy: () => runtimes.some(runtime => runtime.commands.busy()) },
    files: {
      requestUpload: (args, options) => { const { runtime, payload, binding } = fileAdmission(args); return runtime.files.requestUpload(payload, { ...options, binding, verifyTarget: binding ? runtime.verify : undefined }); },
      requestDownload: args => { const { runtime, payload, binding } = fileAdmission(args); return runtime.files.requestDownload(payload, binding); },
      beginUpload: meta => { const { runtime, payload, binding } = fileAdmission(meta); return runtime.files.beginUpload(payload, binding); },
      beginAgentUpload: meta => {
        const { runtime, payload, binding } = fileAdmission(meta);
        if (!binding) throw Error('MCP upload requires an explicit target revision');
        return runtime.files.beginAgentUpload(payload, binding);
      },
      agentUploadStatus: id => agentUploadOwner(id).files.agentUploadStatus(id),
      appendAgentUpload: args => artifactOwner(args.id).files.appendAgentUpload(args),
      finishAgentUpload: id => { const runtime = agentUploadOwner(id); return runtime.files.finishAgentUpload(id, runtime.verify); },
      appendUpload: args => artifactOwner(args.id).files.appendUpload(args),
      finishUpload: id => { const runtime = artifactOwner(id); return runtime.files.finishUpload(id, store.get(id).fileTargetBound === true ? runtime.verify : undefined); },
      busy: () => runtimes.some(runtime => runtime.files.busy()),
      reap: () => store.reap(),
      close: () => Promise.all(runtimes.map(runtime => runtime.files.close())),
    },
    async drain() { await Promise.all(runtimes.flatMap(runtime => [runtime.queue.drain(), runtime.commands.drain(), runtime.cliDrain?.()])); },
  };
}
