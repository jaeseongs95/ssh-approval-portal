/**
 * Application-wide maintenance and shutdown policy; HTTP/timer ownership stays outside.
 * files.close aborts and drains imports; closeTransports stops accepting HTTP work.
 * @param {{queue:import('../domain/approval-queue.mjs').ApprovalQueue, store:{hasActiveWork:()=>boolean}, commands:{busy:()=>boolean}, files:{busy:()=>boolean,reap:()=>Promise<void>,close:()=>Promise<void>},closeConnections:()=>Promise<void>,onReap?:()=>void}} ports
 */
export function createLifecycleService({ queue, store, commands, files, closeConnections, maintenanceState, onReap = () => {} }) {
  let closing, releasedInInstance = false;
  const comparedModes = new Set();
  const comparisonMode = mode => { if (!['strict', 'baseline'].includes(mode)) throw Error('Invalid preservation mode'); return mode; };
  if (maintenanceState?.occupied()) queue.maintenance = true;
  return {
    snapshot() { return { busy: queue.busy() || commands.busy(), pending: queue.list().length, maintenance: queue.maintenance }; },
    reserve(owner) {
      if (maintenanceState?.occupied()) { if (maintenanceState.owns(owner)) return; throw Error('Maintenance is reserved'); }
      if (commands.busy() || files.busy() || store.hasActiveWork()) throw Error('Transfer or read in progress');
      queue.reserveMaintenance();
      try { maintenanceState?.reserve(owner); releasedInInstance = false; comparedModes.clear(); } catch (error) { queue.releaseMaintenance(); throw error; }
    },
    status(owner) {
      const state = maintenanceState?.status(owner) ?? 'unknown';
      return (state === 'released' && (queue.maintenance || !releasedInInstance || !comparedModes.size)) || (state === 'reserved' && !queue.maintenance) ? 'unknown' : state;
    },
    invalidateComparison(owner) { if (!maintenanceState?.owns(owner) || !queue.maintenance) throw Error('Maintenance ownership mismatch'); comparedModes.clear(); },
    markCompared(owner, mode = 'strict') { if (!maintenanceState?.owns(owner) || !queue.maintenance) throw Error('Maintenance ownership mismatch'); comparedModes.add(comparisonMode(mode)); },
    requireCompared(owner, mode = 'strict') {
      if (!comparedModes.has(comparisonMode(mode))) throw Error('Current instance has no verified preservation comparison');
      if (maintenanceState?.status(owner) === 'released' && !queue.maintenance && releasedInInstance) return 'released';
      if (!maintenanceState?.owns(owner) || !queue.maintenance) throw Error('Maintenance ownership mismatch');
      return 'reserved';
    },
    release(owner, requireCompare = false, mode = 'strict') {
      if (requireCompare) this.requireCompared(owner, mode);
      if (maintenanceState?.status(owner) === 'released' && !queue.maintenance && releasedInInstance) return;
      if (maintenanceState && !maintenanceState.owns(owner)) throw Error('Maintenance ownership mismatch');
      // Audit first: if audit fails, the durable claim remains and admission stays closed.
      queue.releaseMaintenance();
      try { maintenanceState?.release(owner); releasedInInstance = true; } catch (error) { queue.maintenance = true; throw error; }
    },
    async reap() {
      // A failing expiry audit must not prevent independent staging/capability cleanup.
      try { queue.reap(); } finally { try { await files.reap(); } finally { onReap(); } }
    },
    close(closeTransports) {
      closing ??= (async () => {
        queue.maintenance = true;
        await files.close();
        await closeTransports();
        await queue.active?.completion;
        await closeConnections();
      })();
      return closing;
    },
  };
}
