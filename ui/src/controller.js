const stale = Symbol('Card view replaced');

export function createCardController({ state, view, host, document, hashFile, encodeFileChunk, timers = globalThis }) {
  let polling = null;
  const notified = new Set();
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
    if (state.mode === 'transfer') return view.transfer(state.transfer, state.meta, (config, file) => submit(config, file, context), target => selectTarget(target, context));
    view.job(state.job, state.meta, { decide: action => decide(action, context), save: () => save(context), output: () => output(context) });
    if (['pending', 'evaluating', 'running'].includes(state.job.state)) polling = timers.setInterval(() => {
      if (!document.hidden) refresh().catch(() => {
        if (state.current(context)) view.error(t('연결이 끊겼습니다. 명령은 재실행하지 않습니다.'));
      });
    }, 2000);
    else {
      const output = state.job.kind === 'command' ? state.job.result?.structuredContent?.output : undefined;
      const notification = { requestId: state.job.id, ...(state.job.targetId ? { targetId: state.job.targetId, targetRevision: state.job.targetRevision } : {}), kind: state.job.kind, state: state.job.state,
        ...(output ? { output } : {}), ...(state.job.kind !== 'command' && state.job.result ? { result: state.job.result } : {}) };
      const key = JSON.stringify(notification);
      if (!notified.has(key)) {
        // ponytail: retain only the latest200 terminal notifications per controller.
        if (notified.size >= 200) notified.delete(notified.values().next().value);
        notified.add(key); host.updateModelContext({ structuredContent: notification }).catch(() => {});
      }
    }
  }
  function output(context, offsetBytes = 0) {
    return act(async context => {
      const ref = context.job?.result?.structuredContent?.output;
      if (!ref?.id || ref.state !== 'ready') return;
      const latest = await call(context, 'show-approval', { id: context.job.id });
      state.mergeMeta(context, latest._meta?.sshApproval);
      const page = await call(context, 'ui-read-command-output', { id: context.job.id, outputId: ref.id, ticket: context.meta.viewTicket, offsetBytes });
      const metadata = page.structuredContent;
      view.output(page._meta?.sshOutput?.text ?? '', metadata, metadata.eof ? null : () => output(context, metadata.nextOffset));
    }, context);
  }
  async function refresh() {
    if (state.disposed || state.mode !== 'job') return;
    const context = state.capture();
    try {
      const result = await call(context, 'get-request-status', { id: context.job.id });
      if (result.structuredContent?.error) { stopPolling(); view.missing(); return; }
      if (result.structuredContent?.state === 'pending' && context.meta.uiEnabled && !context.meta.approvalTicket) {
        receive(await call(context, 'show-approval', { id: context.job.id }));
      } else receive(result);
    } catch (error) { if (error !== stale && state.current(context)) throw error; }
  }
  async function selectTarget(target, context) {
    if (!state.current(context)) return;
    const config = { ...context.transfer, target };
    // Retire the old view before I/O, so its selected File and pending work lose ownership.
    state.revision++; state.busy = false; const selection = state.capture();
    stopPolling(); view.clear(); view.error('');
    try { receive(await call(selection, 'show-file-transfer', config)); }
    catch (error) { if (state.current(selection) && error !== stale) view.error(t('대상 선택에 실패했습니다. 다시 열어 주세요.')); }
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
      const openBrowser = async data => {
        const reply = await host.openLink({ url: data.downloadUrl }); check(context);
        if (reply?.isError) throw Error(t('웹 승인 화면에서 파일을 저장하세요.'));
        view.downloadStatus?.(t('브라우저에서 로그인 후 파일을 저장하세요. 저장된 파일은 기기에서 확인해 주세요.'));
      };
      // Access authentication belongs to the user's browser; a host-side fetch has no login session.
      if (context.meta.downloadRequiresLogin) { await openBrowser(data); return; }
      try {
        check(context);
        const reply = await host.downloadFile({ contents: [{ type: 'resource_link', uri: data.downloadUrl, name: data.fileName, mimeType: 'application/octet-stream' }] });
        check(context);
        if (reply?.isError) throw Error(t('저장 취소 또는 미지원'));
        view.downloadStatus?.(t('파일 저장 요청을 보냈습니다. 저장된 파일은 기기에서 확인해 주세요.'));
      } catch (error) {
        check(context);
        // A failed host save may already have consumed its single-use URL.
        const renewed = await call(context, 'ui-download-link', { id, ticket: context.meta.viewTicket });
        await openBrowser(renewed._meta.sshApproval);
      }
    }, context);
  }
  function submit(config, file, context) {
    config = { ...config };
    return act(async context => {
      if (!context.meta.uiEnabled || !context.transfer) return;
      if (config.direction === 'download') {
        const request = await call(context, 'request-download', { remotePath: config.remotePath, elevate: config.elevate, ...(config.target === undefined ? {} : { target: config.target }) });
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
  return { receive, refresh, decide, save, output, submit, selectTarget, openWeb, dispose };
}
