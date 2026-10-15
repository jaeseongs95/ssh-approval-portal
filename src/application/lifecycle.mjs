/**
 * Application-wide maintenance and shutdown policy; HTTP/timer ownership stays outside.
 * files.close aborts and drains imports; closeTransports stops accepting HTTP work.
 * @param {{queue:import('../domain/approval-queue.mjs').ApprovalQueue, store:{hasActiveWork:()=>boolean}, commands:{busy:()=>boolean}, files:{busy:()=>boolean,reap:()=>Promise<void>,close:()=>Promise<void>},closeConnections:()=>Promise<void>,onReap?:()=>void}} ports
 */
export function createLifecycleService({ queue, store, commands, files, closeConnections, onReap = () => {} }) {
  let closing;
  return {
    snapshot() { return { busy: queue.busy() || commands.busy(), pending: queue.list().length, maintenance: queue.maintenance }; },
    reserve() {
      if (commands.busy() || files.busy() || store.hasActiveWork()) throw Error('Transfer or read in progress');
      queue.reserveMaintenance();
    },
    release() { queue.releaseMaintenance(); },
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
