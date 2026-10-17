export function createWebController({ state, view, api, document, location, timers = globalThis }) {
  const capture = () => ({ target: view.target?.(), revision: view.selectionRevision?.() });
  const current = context => context.target === view.target?.() && context.revision === view.selectionRevision?.();
  function stopPolling() { timers.clearInterval(state.polling); state.polling = null; }
  async function load(force = false) {
    if (state.signedOut) return;
    if (state.loading) {
      await state.loading;
      if (force === true) return load(true);
      return;
    }
    let settled, context = capture();
    state.loading = new Promise(resolve => { settled = resolve; }); view.loading(true);
    try {
      if (view.multiTarget && !state.targetsLoaded) {
        const targets = await api('/api/targets');
        if (state.signedOut) return;
        view.targets(targets, () => load(true)); state.targetsLoaded = true;
      }
      context = capture();
      // One owner-authenticated snapshot feeds both global counts and the local filter.
      const jobs = await api('/api/requests');
      if (state.signedOut || !current(context)) return;
      view.render(jobs, state.deciding); view.connected(); view.error('');
      if (!state.polling) state.polling = timers.setInterval(() => { if (!document.hidden) load(); }, 10000);
    } catch (error) {
      if (!state.signedOut && current(context)) { view.error(error.message); view.disconnected(); }
      stopPolling();
    } finally { state.loading = null; view.loading(state.signedOut); settled(); }
  }
  async function decide(id, action) {
    if (state.signedOut || state.deciding) return;
    const context = capture();
    state.deciding = true; view.deciding(true); view.error('');
    try { await api(`/api/${id}/${action}`, 'POST'); if (!state.signedOut) await load(true); }
    catch (error) { if (!state.signedOut && current(context)) view.error(error.message); }
    finally { state.deciding = false; if (!state.signedOut) view.deciding(false); }
  }
  async function download(id) {
    if (state.signedOut) return;
    const context = capture();
    try {
      const result = await api(`/api/${id}/download`, 'POST');
      if (!state.signedOut && current(context)) location.assign(result.downloadUrl);
    } catch (error) { if (!state.signedOut && current(context)) view.error(error.message); }
  }
  async function output(outputId, offsetBytes = 0) {
    if (state.signedOut) throw Error('Signed out');
    const context = capture();
    const result = await api(`/api/outputs/${outputId}?offset=${offsetBytes}`);
    if (state.signedOut || !current(context)) throw Error('Output view replaced');
    return result;
  }
  function logout() {
    state.signedOut = true; stopPolling(); view.signedOut();
    location.replace(state.accessMode ? '/cdn-cgi/access/logout' : '/');
  }
  function start() {
    view.initialize({ accessMode: state.accessMode, load: () => load(true), decide, download, output, logout });
    if (state.accessMode) return load();
  }
  return { start, load, decide, download, output, logout };
}
