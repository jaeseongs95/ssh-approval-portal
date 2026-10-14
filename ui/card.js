import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'SSH Approval Portal', version: '0.3.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const el = id => document.getElementById(id);
let privateData = {}, job = null, transfer = null, chosenFile = null, polling = null, uploading = false;
const states = { pending: '승인 대기', running: '실행 중', completed: '완료', failed: '실패', denied: '거부됨', expired: '만료됨' };
async function call(name, args) {
  const value = await app.callServerTool({ name: (privateData.namespace ?? 'ssh-approval-bridge_') + name, arguments: args });
  if (value.isError) throw Error('요청이 거부되었습니다. 인증·만료·전송 상태를 확인하세요.');
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
    el('status').textContent = '표시 시험 — 명령은 실행되지 않습니다';
    el('details').replaceChildren(); text(el('details'), 'pre', meta?.privateMarker ?? 'UI 전용 메타데이터를 받지 못했습니다');
    el('controls').replaceChildren(); return;
  }
  if (value.transfer) { transfer = value.transfer; job = null; renderTransfer(); return; }
  if (value.id && value.state) { job = value; transfer = null; renderJob(); }
}
async function refresh() {
  if (!job) return;
  const result = await call('get-request-status', { id: job.id });
  if (result.structuredContent?.error) { clearInterval(polling); el('status').textContent = '요청을 찾을 수 없습니다. 재시작으로 유실됐을 수 있습니다.'; el('controls').replaceChildren(); return; }
  received(result);
}
function renderJob() {
  el('status').textContent = states[job.state] ?? job.state;
  el('details').replaceChildren(); el('controls').replaceChildren();
  text(el('details'), 'p', `${job.target} · ${job.id} · 만료 ${new Date(job.expiresAt).toLocaleString()}`);
  text(el('details'), 'pre', job.kind === 'command' ? job.command : JSON.stringify(job.operation, null, 2));
  if (job.result) text(el('details'), 'pre', job.result.content?.map(x => x.text ?? '').join('\n') || JSON.stringify(job.result.structuredContent ?? job.result));
  if (job.kind !== 'command' && job.result?.structuredContent) text(el('details'), 'pre', JSON.stringify(job.result.structuredContent, null, 2));
  if (job.auditError) text(el('details'), 'p', job.auditError);
  if (job.state === 'pending') for (const action of ['approve', 'deny']) button(el('controls'), action === 'approve' ? '승인·실행' : '거부', async () => {
    received(await call('ui-decide-request', { id: job.id, action, ticket: privateData.approvalTicket }));
  }, !privateData.uiEnabled || !privateData.approvalTicket);
  if (job.kind === 'download' && job.state === 'completed') button(el('controls'), '파일 저장', async () => {
    // Refresh the view capability from the authenticated connection after an old card's ticket expires.
    const latest = await call('show-approval', { id: job.id });
    if (latest._meta?.sshApproval) privateData = { ...privateData, ...latest._meta.sshApproval };
    const result = await call('ui-download-link', { id: job.id, ticket: privateData.viewTicket });
    const data = result._meta?.sshApproval;
    if (!data?.downloadUrl) throw Error('파일 저장 링크를 받지 못했습니다.');
    try {
      const reply = await app.downloadFile({ contents: [{ type: 'resource_link', uri: data.downloadUrl, name: data.fileName, mimeType: 'application/octet-stream' }] });
      if (reply.isError) throw Error('저장 취소 또는 미지원');
    } catch {
      // A host may already have fetched a single-use URL before rejecting its save UI.
      const renewed = await call('ui-download-link', { id: job.id, ticket: privateData.viewTicket });
      const reply = await app.openLink({ url: renewed._meta.sshApproval.downloadUrl });
      if (reply.isError) throw Error('웹 승인 화면에서 파일을 저장하세요.');
    }
  }, !privateData.uiEnabled || !privateData.viewTicket);
  clearInterval(polling);
  if (['pending', 'running'].includes(job.state)) polling = setInterval(() => {
    if (!document.hidden) refresh().catch(() => { el('error').textContent = '연결이 끊겼습니다. 명령은 재실행하지 않습니다.'; });
  }, 2000);
  else app.updateModelContext({ structuredContent: { requestId: job.id, kind: job.kind, state: job.state, result: job.result } }).catch(() => {});
}
function renderTransfer() {
  clearInterval(polling); el('details').replaceChildren(); el('controls').replaceChildren();
  el('status').textContent = transfer.direction === 'upload' ? '파일 업로드 준비' : '파일 다운로드 준비';
  const label = text(el('details'), 'label', '서버의 절대 파일 경로');
  const path = document.createElement('input'); path.type = 'text'; path.value = transfer.remotePath; label.append(path);
  const elevated = document.createElement('input'); elevated.type = 'checkbox'; elevated.checked = transfer.elevate;
  const elevationLabel = text(el('details'), 'label', ' sudo로 전송'); elevationLabel.prepend(elevated);
  let overwrite;
  if (transfer.direction === 'upload') {
    const input = document.createElement('input'); input.type = 'file'; input.onchange = () => { chosenFile = input.files?.[0] ?? null; }; el('details').append(input);
    overwrite = document.createElement('input'); overwrite.type = 'checkbox'; overwrite.checked = transfer.overwrite;
    const replacement = text(el('details'), 'label', ' 기존 파일 덮어쓰기'); replacement.prepend(overwrite);
    text(el('details'), 'p', `최대 ${Math.floor(privateData.maxBytes / 1024 / 1024)} MiB. 서버 반영은 승인 후 진행합니다.`);
  }
  button(el('controls'), transfer.direction === 'upload' ? '파일 전송 후 승인 요청' : '다운로드 요청', async () => {
    if (uploading) return;
    const config = { direction: transfer.direction, remotePath: path.value, elevate: elevated.checked, overwrite: overwrite?.checked ?? false };
    if (config.direction === 'download') {
      const result = await call('request-download', { remotePath: config.remotePath, elevate: config.elevate });
      received(await call('show-approval', { id: result.structuredContent.id })); return;
    }
    if (!chosenFile || chosenFile.size > privateData.maxBytes) throw Error('파일을 선택하고 크기 한도를 확인하세요.');
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
        el('status').textContent = `중계기 전송 ${Math.round(Math.min(offset + chunkSize, file.size) / file.size * 100)}%`;
      }
      received(await call('ui-upload-finish', { id: transferId, ticket: uploadTicket })); chosenFile = null;
    } finally { uploading = false; }
  }, !privateData.uiEnabled);
  if (!privateData.uiEnabled) text(el('details'), 'p', 'UI 동작은 클라이언트 검증 후 활성화됩니다.');
}
app.ontoolresult = received;
app.onhostcontextchanged = context => { if (context.theme) document.documentElement.style.colorScheme = context.theme; };
app.onteardown = async () => { clearInterval(polling); privateData = {}; chosenFile = null; return {}; };
el('web').onclick = async event => { if (event.isTrusted && privateData.webUrl) await app.openLink({ url: privateData.webUrl }); };
await app.connect();
