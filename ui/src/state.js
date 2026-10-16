// One revision owns one visible card and every asynchronous operation started there.
export function createCardState() {
  return {
    revision: 0, mode: 'empty', job: null, transfer: null, meta: {}, fingerprint: '', busy: false, disposed: false,
    apply(result) {
      if (this.disposed) return false;
      const value = result.structuredContent;
      const mode = value?.probe ? 'probe' : value?.transfer ? 'transfer' : value?.id && value?.state ? 'job' : null;
      if (!mode) return false;
      const sameJob = mode === 'job' && this.mode === 'job' && this.job.id === value.id;
      const meta = { ...(sameJob ? this.meta : {}), ...result._meta?.sshApproval };
      const fingerprint = JSON.stringify([value, meta.bridgeDisplayName, meta.targetDisplayName, meta.uiEnabled, !!meta.approvalTicket, !!meta.viewTicket]);
      this.meta = meta;
      if (sameJob && this.fingerprint === fingerprint) return false;
      this.revision++; this.mode = mode; this.job = mode === 'job' ? value : null;
      this.transfer = mode === 'transfer' ? value.transfer : null;
      this.probeMarker = result._meta?.sshApproval?.privateMarker;
      this.fingerprint = fingerprint; this.busy = false;
      return true;
    },
    capture() { return { revision: this.revision, meta: { ...this.meta }, job: this.job, transfer: this.transfer }; },
    current(context) { return !this.disposed && context.revision === this.revision; },
    mergeMeta(context, meta) {
      if (!this.current(context)) return;
      Object.assign(context.meta, meta); Object.assign(this.meta, meta);
    },
    dispose() {
      this.disposed = true; this.revision++; this.meta = {}; this.job = this.transfer = null; this.busy = false;
    },
  };
}
