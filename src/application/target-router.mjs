import { fileTargetFields } from '../domain/file-target-binding.mjs';

/** Single-process synchronous claims; callers release in finally, with no hidden waiting queue. */
export function createClaims(limit) {
  let used = 0;
  const claim = () => {
    if (used >= limit) throw Error('Global concurrency limit reached');
    used++;
    let released = false;
    return () => { if (!released) { released = true; used--; } };
  };
  claim.busy = () => used >= limit;
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
      if (maintenance || runtimes.some(runtime => runtime.commands.busy() || runtime.files.busy() || runtime.queue.busy() || runtime.queue.list().length) || store.hasActiveWork()) throw Error('All targets must finish before maintenance');
      audit({ action: 'maintenance-reserved' }); queue.maintenance = true;
    },
    releaseMaintenance() { audit({ action: 'maintenance-released' }); queue.maintenance = false; },
  };
  return {
    legacy, select, jobOwner, artifactOwner, queue,
    list: () => ({ targets: runtimes.map(({ id, displayName, enabled, revision }) => ({ id, displayName, enabled, revision, isDefault: id === defaultTarget })), defaultTarget: defaultTarget ?? null }),
    canonicalTransfer(args) { const runtime = select(args.target); return legacy && args.target === undefined ? args : { ...args, target: runtime.id }; },
    commands: { read: (command, target) => select(target).commands.read(command), run: (command, target, requestKey, context, displayContext) => select(target).commands.run(command, requestKey, context, displayContext),
      runSource: (args, target) => select(target).commands.runSource(args), source: id => { const runtime = jobOwner(id); select(runtime.id).verify(); return runtime.commands.source(id); },
      busy: () => runtimes.some(runtime => runtime.commands.busy()) },
    files: {
      requestUpload: (args, options) => { const { runtime, payload, binding } = fileAdmission(args); return runtime.files.requestUpload(payload, { ...options, binding, verifyTarget: binding ? runtime.verify : undefined }); },
      requestDownload: args => { const { runtime, payload, binding } = fileAdmission(args); return runtime.files.requestDownload(payload, binding); },
      beginUpload: meta => { const { runtime, payload, binding } = fileAdmission(meta); return runtime.files.beginUpload(payload, binding); },
      appendUpload: args => artifactOwner(args.id).files.appendUpload(args),
      finishUpload: id => { const runtime = artifactOwner(id); return runtime.files.finishUpload(id, store.get(id).fileTargetBound === true ? runtime.verify : undefined); },
      busy: () => runtimes.some(runtime => runtime.files.busy()),
      reap: () => store.reap(),
      close: () => Promise.all(runtimes.map(runtime => runtime.files.close())),
    },
    async drain() { await Promise.all(runtimes.flatMap(runtime => [runtime.queue.active?.completion, runtime.commands.drain(),runtime.cliDrain?.()])); },
  };
}
