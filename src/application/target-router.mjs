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
    const runtime = runtimes.find(runtime => runtime.queue.jobs.has(id));
    if (!runtime) throw Error('Unknown request');
    return runtime;
  };
  const artifactOwner = id => {
    const item = store.get(id), runtime = select(item.targetId ?? (legacy ? 'default' : undefined));
    if (!legacy && item.targetRevision !== runtime.revision) throw Error('Stale artifact');
    return runtime;
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
    list: () => ({ targets: runtimes.map(({ id, displayName, enabled }) => ({ id, displayName, enabled, isDefault: id === defaultTarget })), defaultTarget: defaultTarget ?? null }),
    canonicalTransfer(args) { const runtime = select(args.target); return legacy && args.target === undefined ? args : { ...args, target: runtime.id }; },
    commands: { read: (command, target) => select(target).commands.read(command), run: (command, target, requestKey, context, displayContext) => select(target).commands.run(command, requestKey, context, displayContext), busy: () => runtimes.some(runtime => runtime.commands.busy()) },
    files: {
      requestUpload: (args, options) => select(args.target).files.requestUpload(args, options),
      requestDownload: args => select(args.target).files.requestDownload(args),
      beginUpload: meta => select(meta.target).files.beginUpload(meta),
      appendUpload: args => artifactOwner(args.id).files.appendUpload(args),
      finishUpload: id => artifactOwner(id).files.finishUpload(id),
      busy: () => runtimes.some(runtime => runtime.files.busy()),
      reap: () => store.reap(),
      close: () => Promise.all(runtimes.map(runtime => runtime.files.close())),
    },
    async drain() { await Promise.all(runtimes.flatMap(runtime => [runtime.queue.active?.completion, runtime.commands.drain()])); },
  };
}
