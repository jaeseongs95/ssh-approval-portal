export function createWebController({ state, view, api, document, location, timers = globalThis }) {
  const capture = () => ({ target: view.target?.(), revision: view.selectionRevision?.() });
  const current = context => context.target === view.target?.() && context.revision === view.selectionRevision?.();
  let generation = 0, activeRead, uncertainDecision, activeDownloads = 0;
  const uncertainMessage = () => view.uncertainDecisionMessage?.() ?? 'Approval result needs checking. Refresh requests; do not repeat the action.';
  function stopPolling() { timers.clearInterval(state.polling); state.polling = null; }
  async function load(force = false) {
    if (state.signedOut) return;
    if (state.loading && force !== true) return state.loading;
    activeRead?.abort();
    const read = activeRead = new AbortController(), token = ++generation;
    if (!state.polling) state.polling = timers.setInterval(() => { if (!document.hidden) load(); }, 10000);
    let settled, context = capture();
    state.loading = new Promise(resolve => { settled = resolve; }); view.loading(true);
    try {
      if (view.multiTarget && !state.targetsLoaded) {
        const targets = await api('/api/targets', 'GET', undefined, { signal: read.signal });
        if (state.signedOut || token !== generation) return;
        view.targets(targets, () => load(true)); state.targetsLoaded = true;
      }
      context = capture();
      // One owner-authenticated snapshot feeds both global counts and the local filter.
      const jobs = await api('/api/requests', 'GET', undefined, { signal: read.signal });
      if (state.signedOut || token !== generation || !current(context)) return;
      const matches = uncertainDecision ? jobs.filter(job => job.id === uncertainDecision) : [];
      if (matches.length === 1 && ['running', 'completed', 'failed', 'denied', 'expired', 'unknown'].includes(matches[0].state)) uncertainDecision = undefined;
      view.render(jobs, state.deciding || !!uncertainDecision); view.connected(); view.error(uncertainDecision ? uncertainMessage() : '');
    } catch (error) {
      if (!state.signedOut && token === generation && !read.signal.aborted && current(context)) {
        view.error((uncertainDecision ? uncertainMessage() + ' ' : '') + error.message); view.disconnected();
        if (error.status >= 400 && error.status < 500) stopPolling();
      }
    } finally { if (token === generation) { state.loading = null; view.loading(state.signedOut); } settled(); }
  }
  async function decide(id, action) {
    if (state.signedOut || state.deciding || uncertainDecision) return;
    const context = capture();
    state.deciding = true; view.deciding(true); view.error('');
    try { await api(`/api/${id}/${action}`, 'POST'); if (!state.signedOut) await load(true); }
    catch (error) {
      if (!state.signedOut) { uncertainDecision = id; view.error(uncertainMessage()); await load(true); }
    }
    finally { state.deciding = false; if (!state.signedOut) view.deciding(!!uncertainDecision); }
  }
  async function download(id) {
    if (state.signedOut || activeDownloads) return;
    activeDownloads++;
    const context = capture(), page = document.body?.dataset.page;
    try {
      const result = await api(`/api/${id}/download`, 'POST');
      if (!state.signedOut && current(context) && page === document.body?.dataset.page) location.assign(result.downloadUrl);
    } catch (error) { if (!state.signedOut && current(context)) view.error(error.message); }
    finally { activeDownloads--; }
  }
  async function output(outputId, offsetBytes = 0) {
    if (state.signedOut) throw Error('Signed out');
    const context = capture();
    const result = await api(`/api/outputs/${outputId}?offset=${offsetBytes}`);
    if (state.signedOut || !current(context)) throw Error('Output view replaced');
    return result;
  }
  function logout() {
    state.signedOut = true; generation++; activeRead?.abort(); stopPolling(); view.signedOut();
    location.replace(state.accessMode ? '/cdn-cgi/access/logout' : '/');
  }
  function start() {
    view.initialize({ accessMode: state.accessMode, load: () => load(true), decide, download, output, logout });
    if (state.accessMode) return load();
  }
  return { start, load, decide, download, output, logout, reloadState: () => ({ blocked: state.deciding || !!uncertainDecision || activeDownloads > 0 }) };
}
