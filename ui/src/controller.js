const stale = Symbol('Card view replaced');

export function createCardController({ state, view, host, document, hashFile, encodeFileChunk, timers = globalThis }) {
  let polling = null;
  const t = view.t;
  const stopPolling = () => { timers.clearInterval(polling); polling = null; };
  function check(context) { if (!state.current(context)) throw stale; }
  async function call(context, name, args) {
    check(context);
    const result = await host.call(name, args, context.meta.namespace);
    check(context); return result;
  }
  async function act(task, context = state.capture()) {
    if (!state.current(context) || state.busy) return;
    state.busy = true; view.setBusy(true); view.error('');
    try { await task(context); }
    catch (error) { if (state.current(context) && error !== stale) view.error(error.message); }
    finally { if (state.current(context)) { state.busy = false; view.setBusy(false); } }
  }
  function receive(result) {
    if (!state.apply(result)) return;
    stopPolling(); view.error('');
    const context = state.capture();
    if (state.mode === 'probe') return view.probe(state.probeMarker, state.meta);
    if (state.mode === 'transfer') return view.transfer(state.transfer, state.meta, (config, file) => submit(config, file, context));
    view.job(state.job, state.meta, { decide: action => decide(action, context), save: () => save(context) });
    if (['pending', 'running'].includes(state.job.state)) polling = timers.setInterval(() => {
      if (!document.hidden) refresh().catch(() => {
        if (state.current(context)) view.error(t('연결이 끊겼습니다. 명령은 재실행하지 않습니다.'));
      });
    }, 2000);
    else host.updateModelContext({ structuredContent: { requestId: state.job.id, kind: state.job.kind, state: state.job.state, result: state.job.result } }).catch(() => {});
  }
  async function refresh() {
    if (state.disposed || state.mode !== 'job') return;
    const context = state.capture();
    try {
      const result = await call(context, 'get-request-status', { id: context.job.id });
      if (result.structuredContent?.error) { stopPolling(); view.missing(); return; }
      receive(result);
    } catch (error) { if (error !== stale && state.current(context)) throw error; }
  }
  function decide(action, context) {
    return act(async context => {
      if (!context.meta.uiEnabled || !context.meta.approvalTicket || context.job?.state !== 'pending') return;
      receive(await call(context, 'ui-decide-request', { id: context.job.id, action, ticket: context.meta.approvalTicket }));
    }, context);
  }
  function save(context) {
    return act(async context => {
      if (!context.meta.uiEnabled || !context.meta.viewTicket || context.job?.kind !== 'download' || context.job.state !== 'completed') return;
      const id = context.job.id;
      const latest = await call(context, 'show-approval', { id });
      state.mergeMeta(context, latest._meta?.sshApproval);
      const link = await call(context, 'ui-download-link', { id, ticket: context.meta.viewTicket });
      const data = link._meta?.sshApproval;
      if (!data?.downloadUrl) throw Error(t('파일 저장 링크를 받지 못했습니다.'));
      try {
        check(context);
        const reply = await host.downloadFile({ contents: [{ type: 'resource_link', uri: data.downloadUrl, name: data.fileName, mimeType: 'application/octet-stream' }] });
        check(context);
        if (reply.isError) throw Error(t('저장 취소 또는 미지원'));
      } catch (error) {
        check(context);
        // A failed host save may already have consumed its single-use URL.
        const renewed = await call(context, 'ui-download-link', { id, ticket: context.meta.viewTicket });
        const reply = await host.openLink({ url: renewed._meta.sshApproval.downloadUrl });
        check(context);
        if (reply.isError) throw Error(t('웹 승인 화면에서 파일을 저장하세요.'));
      }
    }, context);
  }
  function submit(config, file, context) {
    config = { ...config };
    return act(async context => {
      if (!context.meta.uiEnabled || !context.transfer) return;
      if (config.direction === 'download') {
        const request = await call(context, 'request-download', { remotePath: config.remotePath, elevate: config.elevate });
        receive(await call(context, 'show-approval', { id: request.structuredContent.id })); return;
      }
      if (!file || file.size > context.meta.maxBytes) throw Error(t('파일을 선택하고 크기 한도를 확인하세요.'));
      const sha256 = await hashFile(file); check(context);
      const fresh = await call(context, 'show-file-transfer', config);
      const start = await call(context, 'ui-upload-begin', { transfer: config, ticket: fresh._meta.sshApproval.bootstrapTicket, fileName: file.name, size: file.size, sha256 });
      const id = start.structuredContent.transferId, ticket = start._meta.sshApproval.uploadTicket;
      const chunkSize = context.meta.chunkBytes ?? 262144;
      for (let offset = 0, sequence = 0; offset < file.size; offset += chunkSize, sequence++) {
        const data = await encodeFileChunk(file, offset, offset + chunkSize); check(context);
        await call(context, 'ui-upload-chunk', { id, ticket, sequence, data });
        view.progress(Math.round(Math.min(offset + chunkSize, file.size) / file.size * 100));
      }
      receive(await call(context, 'ui-upload-finish', { id, ticket }));
    }, context);
  }
  async function openWeb() {
    const context = state.capture();
    if (state.current(context) && context.meta.webUrl) await host.openLink({ url: context.meta.webUrl });
  }
  function dispose() { stopPolling(); state.dispose(); view.clear(); }
  return { receive, refresh, decide, save, submit, openWeb, dispose };
}
