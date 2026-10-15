export function createWebController({ state, view, api, document, location, timers = globalThis }) {
  function stopPolling() { timers.clearInterval(state.polling); state.polling = null; }
  async function load(force = false) {
    if (state.signedOut) return;
    if (state.loading) {
      await state.loading;
      if (force === true) return load(true);
      return;
    }
    let settled;
    state.loading = new Promise(resolve => { settled = resolve; }); view.loading(true);
    try {
      const jobs = await api('/api/requests');
      if (state.signedOut) return;
      view.render(jobs, state.deciding); view.connected(); view.error('');
      if (!state.polling) state.polling = timers.setInterval(() => { if (!document.hidden) load(); }, 10000);
    } catch (error) {
      if (!state.signedOut) { view.error(error.message); view.disconnected(); }
      stopPolling();
    } finally { state.loading = null; view.loading(state.signedOut); settled(); }
  }
  async function decide(id, action) {
    if (state.signedOut || state.deciding) return;
    state.deciding = true; view.deciding(true); view.error('');
    try { await api(`/api/${id}/${action}`, 'POST'); if (!state.signedOut) await load(true); }
    catch (error) { if (!state.signedOut) view.error(error.message); }
    finally { state.deciding = false; if (!state.signedOut) view.deciding(false); }
  }
  async function download(id) {
    if (state.signedOut) return;
    try {
      const result = await api(`/api/${id}/download`, 'POST');
      if (!state.signedOut) location.assign(result.downloadUrl);
    } catch (error) { if (!state.signedOut) view.error(error.message); }
  }
  function logout() {
    state.signedOut = true; stopPolling(); view.signedOut();
    location.replace(state.accessMode ? '/cdn-cgi/access/logout' : '/');
  }
  function start() {
    view.initialize({ accessMode: state.accessMode, load: () => load(true), decide, download, logout });
    if (state.accessMode) return load();
  }
  return { start, load, decide, download, logout };
}
