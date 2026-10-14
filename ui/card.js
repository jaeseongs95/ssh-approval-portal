import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'SSH Approval Portal', version: '0.3.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const el = id => document.getElementById(id);
const korean = (navigator.language ?? 'en').toLowerCase().startsWith('ko');
const locale = korean ? 'ko-KR' : 'en-US';
const en = {
  '승인 대기': 'Awaiting approval', '실행 중': 'Running', '완료': 'Completed', '실패': 'Failed', '거부됨': 'Denied', '만료됨': 'Expired',
  '요청이 거부되었습니다. 인증·만료·전송 상태를 확인하세요.': 'Request refused. Check authentication, expiration and transfer state.',
  '표시 시험 — 명령은 실행되지 않습니다': 'Display test — no commands will run', 'UI 전용 메타데이터를 받지 못했습니다': 'UI-only metadata was not received',
  '요청을 찾을 수 없습니다. 재시작으로 유실됐을 수 있습니다.': 'Request not found. It may have been lost after a restart.',
  '대상 서버': 'Target server', '요청 정보': 'Request details', '요청': 'Request', '승인 만료': 'Approval expires', '실행할 명령': 'Command to execute', '파일 전송 내용': 'File transfer details',
  '방향': 'Direction', 'PC → 서버': 'PC → Server', '서버 → PC': 'Server → PC', '파일명': 'File name', '서버 경로': 'Remote path', '크기': 'Size', '바이트': 'bytes',
  'sudo 사용': 'Use sudo', '예': 'Yes', '아니요': 'No', '덮어쓰기': 'Overwrite', '실행 결과': 'Execution result', '파일 전송에 실패했습니다.': 'File transfer failed.',
  '승인·실행': 'Approve and run', '거부': 'Deny', '파일 저장': 'Save file', '파일 저장 링크를 받지 못했습니다.': 'No file download link was received.',
  '저장 취소 또는 미지원': 'Save cancelled or unsupported', '웹 승인 화면에서 파일을 저장하세요.': 'Save the file from the web approval page.',
  '연결이 끊겼습니다. 명령은 재실행하지 않습니다.': 'Connection lost. The command will not be executed again.',
  '파일 업로드 준비': 'Ready to upload', '파일 다운로드 준비': 'Ready to download', '서버의 절대 파일 경로': 'Absolute remote file path',
  ' sudo로 전송': ' Transfer using sudo', ' 기존 파일 덮어쓰기': ' Overwrite existing file', '최대': 'Maximum', '서버 반영은 승인 후 진행합니다.': 'The remote file changes only after approval.',
  '파일 전송 후 승인 요청': 'Send file and request approval', '다운로드 요청': 'Request download', '파일을 선택하고 크기 한도를 확인하세요.': 'Choose a file within the size limit.',
  '중계기 전송': 'Uploading to bridge', 'UI 동작은 클라이언트 검증 후 활성화됩니다.': 'UI actions are enabled after client verification.',
};
const t = value => korean ? value : en[value] ?? value;
document.documentElement.lang = korean ? 'ko' : 'en';
document.title = korean ? 'SSH 승인 및 파일 전송' : 'SSH approval and file transfer';
el('details').ariaLabel = korean ? '요청 내용' : 'Request details';
if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
let privateData = {}, job = null, transfer = null, chosenFile = null, polling = null, uploading = false;
let renderedJob = '', viewRevision = 0;
const states = Object.fromEntries(Object.entries({ pending: '승인 대기', running: '실행 중', completed: '완료', failed: '실패', denied: '거부됨', expired: '만료됨' }).map(([key,value]) => [key,t(value)]));
async function call(name, args) {
  const value = await app.callServerTool({ name: (privateData.namespace ?? 'ssh-approval-bridge_') + name, arguments: args });
  if (value.isError) throw Error(t('요청이 거부되었습니다. 인증·만료·전송 상태를 확인하세요.'));
  return value;
}
function text(parent, tag, value) { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; }
function button(parent, title, action, disabled = false) {
  const node = text(parent, 'button', title); node.disabled = disabled;
  node.onclick = async event => {
    if (!event.isTrusted || node.disabled) return;
    node.disabled = true; el('error').textContent = '';
    try { await action(); } catch (err) { el('error').textContent = err.message; }
    finally { if (node.isConnected) node.disabled = disabled; }
  };
  return node;
}
function received(result) {
  const value = result.structuredContent;
  const meta = result._meta?.sshApproval;
  if (meta) privateData = { ...privateData, ...meta };
  if (!value) return;
  if (value.probe) {
    renderedJob = ''; job = null; transfer = null; clearInterval(polling);
    delete el('status').dataset.state;
    el('status').textContent = t('표시 시험 — 명령은 실행되지 않습니다');
    el('details').replaceChildren(); text(el('details'), 'pre', meta?.privateMarker ?? t('UI 전용 메타데이터를 받지 못했습니다'));
    el('controls').replaceChildren(); return;
  }
  if (value.transfer) { renderedJob = ''; transfer = value.transfer; job = null; renderTransfer(); return; }
  if (value.id && value.state) { job = value; transfer = null; renderJob(); }
}
async function refresh() {
  if (!job) return;
  const requestId = job.id, revision = viewRevision;
  const result = await call('get-request-status', { id: requestId });
  if (revision !== viewRevision || job?.id !== requestId) return;
  if (result.structuredContent?.error) { clearInterval(polling); el('status').textContent = t('요청을 찾을 수 없습니다. 재시작으로 유실됐을 수 있습니다.'); el('controls').replaceChildren(); return; }
  received(result);
}
function renderJob() {
  const view = JSON.stringify([job, privateData.uiEnabled, !!privateData.approvalTicket, !!privateData.viewTicket]);
  // Keep the same DOM, focused button and host height during unchanged status polls.
  if (view === renderedJob) return;
  renderedJob = view;
  viewRevision++;
  el('status').dataset.state = job.state;
  el('status').textContent = states[job.state] ?? job.state;
  el('details').replaceChildren(); el('controls').replaceChildren();
  const meta = text(el('details'), 'div', ''); meta.className = 'request-meta';
  text(meta, 'p', `${t('대상 서버')} · ${job.target}`);
  const info = text(meta, 'details', ''); text(info, 'summary', t('요청 정보'));
  text(info, 'p', `${t('요청')} ${job.id}`).className = 'request-id';
  text(info, 'p', `${t('승인 만료')} ${new Date(job.expiresAt).toLocaleString(locale)}`);
  text(el('details'), 'p', t(job.kind === 'command' ? '실행할 명령' : '파일 전송 내용')).className = 'section-label';
  if (job.kind === 'command') text(el('details'), 'pre', job.command);
  else {
    const op = job.operation, result = job.result?.structuredContent;
    const list = text(el('details'), 'dl', ''); list.className = 'operation-fields';
    for (const [label, value] of [
      ['방향', t(job.kind === 'upload' ? 'PC → 서버' : '서버 → PC')],
      ['파일명', op.fileName ?? result?.fileName ?? op.remotePath.split('/').pop()],
      ['서버 경로', op.remotePath], ['크기', op.size ?? result?.size], ['SHA-256', op.sha256 ?? result?.sha256],
      ['sudo 사용', t(op.elevate ? '예' : '아니요')], ...(job.kind === 'upload' ? [['덮어쓰기', t(op.overwrite ? '예' : '아니요')]] : []),
    ]) {
      if (value === undefined) continue;
      text(list, 'dt', t(label)); const entry = text(list, 'dd', label === '크기' ? `${value.toLocaleString(locale)} ${t('바이트')}` : value);
      if (label === 'SHA-256') entry.className = 'hash';
    }
  }
  if (job.result && job.kind === 'command') {
    text(el('details'), 'p', t('실행 결과')).className = 'section-label';
    text(el('details'), 'pre', job.result.content?.map(x => x.text ?? '').join('\n') || JSON.stringify(job.result.structuredContent ?? job.result));
  }
  if (job.result?.isError && job.kind !== 'command') text(el('details'), 'pre', job.result.content?.map(x => x.text ?? '').join('\n') ?? t('파일 전송에 실패했습니다.'));
  if (job.auditError) text(el('details'), 'p', job.auditError);
  if (job.state === 'pending') for (const action of ['approve', 'deny']) button(el('controls'), t(action === 'approve' ? '승인·실행' : '거부'), async () => {
    received(await call('ui-decide-request', { id: job.id, action, ticket: privateData.approvalTicket }));
  }, !privateData.uiEnabled || !privateData.approvalTicket);
  if (job.kind === 'download' && job.state === 'completed') button(el('controls'), t('파일 저장'), async () => {
    // Refresh the view capability from the authenticated connection after an old card's ticket expires.
    const latest = await call('show-approval', { id: job.id });
    if (latest._meta?.sshApproval) privateData = { ...privateData, ...latest._meta.sshApproval };
    const result = await call('ui-download-link', { id: job.id, ticket: privateData.viewTicket });
    const data = result._meta?.sshApproval;
    if (!data?.downloadUrl) throw Error(t('파일 저장 링크를 받지 못했습니다.'));
    try {
      const reply = await app.downloadFile({ contents: [{ type: 'resource_link', uri: data.downloadUrl, name: data.fileName, mimeType: 'application/octet-stream' }] });
      if (reply.isError) throw Error(t('저장 취소 또는 미지원'));
    } catch {
      // A host may already have fetched a single-use URL before rejecting its save UI.
      const renewed = await call('ui-download-link', { id: job.id, ticket: privateData.viewTicket });
      const reply = await app.openLink({ url: renewed._meta.sshApproval.downloadUrl });
      if (reply.isError) throw Error(t('웹 승인 화면에서 파일을 저장하세요.'));
    }
  }, !privateData.uiEnabled || !privateData.viewTicket);
  clearInterval(polling);
  if (['pending', 'running'].includes(job.state)) polling = setInterval(() => {
    if (!document.hidden) refresh().catch(() => { el('error').textContent = t('연결이 끊겼습니다. 명령은 재실행하지 않습니다.'); });
  }, 2000);
  else app.updateModelContext({ structuredContent: { requestId: job.id, kind: job.kind, state: job.state, result: job.result } }).catch(() => {});
}
function renderTransfer() {
  delete el('status').dataset.state;
  clearInterval(polling); el('details').replaceChildren(); el('controls').replaceChildren();
  el('status').textContent = t(transfer.direction === 'upload' ? '파일 업로드 준비' : '파일 다운로드 준비');
  const label = text(el('details'), 'label', t('서버의 절대 파일 경로'));
  const path = document.createElement('input'); path.type = 'text'; path.value = transfer.remotePath; label.append(path);
  const elevated = document.createElement('input'); elevated.type = 'checkbox'; elevated.checked = transfer.elevate;
  const elevationLabel = text(el('details'), 'label', t(' sudo로 전송')); elevationLabel.prepend(elevated);
  let overwrite;
  if (transfer.direction === 'upload') {
    const input = document.createElement('input'); input.type = 'file'; input.onchange = () => { chosenFile = input.files?.[0] ?? null; }; el('details').append(input);
    overwrite = document.createElement('input'); overwrite.type = 'checkbox'; overwrite.checked = transfer.overwrite;
    const replacement = text(el('details'), 'label', t(' 기존 파일 덮어쓰기')); replacement.prepend(overwrite);
    text(el('details'), 'p', `${t('최대')} ${Math.floor(privateData.maxBytes / 1024 / 1024)} MiB. ${t('서버 반영은 승인 후 진행합니다.')}`);
  }
  button(el('controls'), t(transfer.direction === 'upload' ? '파일 전송 후 승인 요청' : '다운로드 요청'), async () => {
    if (uploading) return;
    const config = { direction: transfer.direction, remotePath: path.value, elevate: elevated.checked, overwrite: overwrite?.checked ?? false };
    if (config.direction === 'download') {
      const result = await call('request-download', { remotePath: config.remotePath, elevate: config.elevate });
      received(await call('show-approval', { id: result.structuredContent.id })); return;
    }
    if (!chosenFile || chosenFile.size > privateData.maxBytes) throw Error(t('파일을 선택하고 크기 한도를 확인하세요.'));
    uploading = true;
    try {
      const file = chosenFile;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
      const sha256 = [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
      const fresh = await call('show-file-transfer', config);
      const bootstrap = fresh._meta.sshApproval.bootstrapTicket;
      const start = await call('ui-upload-begin', { transfer: config, ticket: bootstrap, fileName: file.name, size: file.size, sha256 });
      const transferId = start.structuredContent.transferId, uploadTicket = start._meta.sshApproval.uploadTicket;
      const chunkSize = privateData.chunkBytes ?? 262144;
      for (let offset = 0, sequence = 0; offset < file.size; offset += chunkSize, sequence++) {
        const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        await call('ui-upload-chunk', { id: transferId, ticket: uploadTicket, sequence, data: btoa(binary) });
        el('status').textContent = `${t('중계기 전송')} ${Math.round(Math.min(offset + chunkSize, file.size) / file.size * 100)}%`;
      }
      received(await call('ui-upload-finish', { id: transferId, ticket: uploadTicket })); chosenFile = null;
    } finally { uploading = false; }
  }, !privateData.uiEnabled);
  if (!privateData.uiEnabled) text(el('details'), 'p', t('UI 동작은 클라이언트 검증 후 활성화됩니다.'));
}
app.ontoolresult = received;
function applyTheme(context) {
  if (!context?.theme) return;
  document.documentElement.style.colorScheme = context.theme;
  document.documentElement.dataset.theme = context.theme;
}
app.onhostcontextchanged = applyTheme;
app.onteardown = async () => { clearInterval(polling); privateData = {}; chosenFile = null; return {}; };
el('web').onclick = async event => { if (event.isTrusted && privateData.webUrl) await app.openLink({ url: privateData.webUrl }); };
await app.connect();
applyTheme(app.getHostContext());
