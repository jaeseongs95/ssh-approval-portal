const el = id => document.getElementById(id);
const korean = (navigator.language ?? 'en').toLowerCase().startsWith('ko');
const locale = korean ? 'ko-KR' : 'en-US';
const en = {
  '승인 대기': 'Awaiting approval', '실행 중': 'Running', '완료': 'Completed', '실패': 'Failed', '거부': 'Denied', '만료': 'Expired',
  '명령 실행': 'Command', '파일 업로드': 'File upload', '파일 다운로드': 'File download', '요청 실패': 'Request failed',
  '요청': 'Request', '처리 완료': 'Finished', '승인·실행': 'Approve and run', '실행 결과': 'Execution result', '파일 저장': 'Save file',
  '대기 중인 요청이 없습니다': 'No pending requests', '새 승인 요청이 들어오면 여기에 표시됩니다.': 'New approval requests will appear here.',
  '아직 승인 이력이 없습니다': 'No approval history yet', '승인·거부된 요청의 상태와 결과가 여기에 표시됩니다.': 'Statuses and results of processed requests will appear here.',
  '연결됨': 'Connected', '마지막 갱신': 'Last refreshed', '10초마다 갱신': 'Refreshes every 10 seconds', '연결 확인 필요': 'Check connection',
  '요청 목록을 연결해 주세요': 'Connect to view requests', '관리자 토큰을 입력하고 요청 조회를 누르세요.': 'Enter your administrator token and refresh requests.',
  '처리 이력을 한눈에': 'Your approval history', '실행 중인 요청부터 완료된 결과까지 확인할 수 있습니다.': 'View running requests and completed results.', '관리자 토큰': 'Administrator token',
};
const t = value => korean ? value : en[value] ?? value;
document.documentElement.lang = korean ? 'ko' : 'en';
document.title = korean ? 'SSH 승인 · Approval Portal' : 'SSH approvals · Approval Portal';
if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
el('token').placeholder = el('token').ariaLabel = t('관리자 토큰');
const states = Object.fromEntries(Object.entries({ pending: '승인 대기', running: '실행 중', completed: '완료', failed: '실패', denied: '거부', expired: '만료' }).map(([key,value]) => [key,t(value)]));
const kinds = Object.fromEntries(Object.entries({ command: '명령 실행', upload: '파일 업로드', download: '파일 다운로드' }).map(([key,value]) => [key,t(value)]));
let polling = null, loading = false, deciding = false, rendered = '';
function text(parent, tag, value, className = '') {
  const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
}
function empty(parent, title, note) {
  const box = text(parent, 'div', '', 'empty'); text(box, 'span', '—', 'empty-mark'); text(box, 'strong', title); text(box, 'p', note);
}
function error(message = '') { el('error').textContent = message; el('error').hidden = !message; }
async function api(path, method = 'GET') {
  const r = await fetch(path, { method, headers: { Authorization: 'Bearer ' + el('token').value } });
  const value = await r.json(); if (!r.ok) throw Error(value.error ?? t('요청 실패')); return value;
}
async function load() {
  if (loading) return;
  loading = true; el('load').disabled = true;
  try {
    const jobs = await api('/api/requests');
    const fingerprint = JSON.stringify(jobs);
    if (fingerprint !== rendered) {
    const open = new Set([...el('history').querySelectorAll('details[open]')].map(x => x.dataset.requestId));
    el('jobs').replaceChildren(); el('history').replaceChildren();
    const pending = jobs.filter(job => job.state === 'pending').length;
    el('pending-count').textContent = pending; el('history-count').textContent = jobs.length - pending;
    for (const job of jobs.reverse()) {
      const waiting = job.state === 'pending', parent = waiting ? el('jobs') : el('history');
      const box = document.createElement(waiting ? 'article' : 'details'); box.className = 'request' + (waiting ? '' : ' history-item');
      const command = job.kind === 'command' ? job.command : JSON.stringify(job.operation, null, 2);
      let body = box;
      if (!waiting) {
        box.dataset.requestId = job.id; box.open = open.has(job.id);
        const summary = text(box, 'summary', ''); const head = text(summary, 'div', '', 'summary-head');
        text(head, 'span', '›', 'chevron'); text(head, 'span', kinds[job.kind] ?? job.kind, 'kind');
        text(head, 'span', states[job.state] ?? job.state, `badge ${job.state}`);
        text(summary, 'span', command, 'preview'); body = text(box, 'div', '', 'history-body');
      } else {
        const head = text(box, 'div', '', 'request-top'); text(head, 'span', kinds[job.kind] ?? job.kind, 'kind'); text(head, 'span', t('승인 대기'), 'badge pending');
      }
      text(body, 'p', job.target, 'target'); text(body, 'pre', command, 'command');
      const meta = text(body, 'div', '', 'meta'); text(meta, 'span', `${t('요청')} ${job.id}`, 'request-id');
      const time = waiting ? job.expiresAt : job.finishedAt ?? job.createdAt;
      text(meta, 'span', `${t(waiting ? '만료' : job.finishedAt ? '처리 완료' : '요청')} ${new Date(time).toLocaleString(locale)}`);
      const actions = text(body, 'div', '', 'actions');
      if (job.state === 'pending') for (const action of ['approve', 'deny']) {
        const b = text(actions, 'button', t(action === 'approve' ? '승인·실행' : '거부'), action === 'approve' ? 'primary' : 'secondary reject');
        b.disabled = deciding;
        b.onclick = async () => {
          if (deciding) return; deciding = true; error();
          for (const button of el('jobs').querySelectorAll('button')) button.disabled = true;
          try { await api(`/api/${job.id}/${action}`, 'POST'); await load(); }
          catch (e) { error(e.message); }
          finally { deciding = false; for (const button of el('jobs').querySelectorAll('button')) button.disabled = false; }
        };
      }
      if (job.result) {
        text(body, 'p', t('실행 결과'), 'output-label');
        const blocks = job.result.content?.filter(x => x.type === 'text');
        const output = blocks?.length ? blocks.map(x => x.text ?? '').join('\n') : JSON.stringify(job.result.structuredContent ?? job.result, null, 2);
        text(body, 'pre', output, 'output');
      }
      if (job.auditError) text(body, 'p', job.auditError, 'error');
      if (job.state === 'completed' && job.kind === 'download') {
        const b = text(actions, 'button', t('파일 저장'), 'secondary'); b.onclick = async () => {
          try { const r = await api(`/api/${job.id}/download`, 'POST'); location.assign(r.downloadUrl); } catch (e) { error(e.message); }
        };
      }
      if (!actions.childElementCount) actions.remove(); parent.append(box);
    }
    if (!pending) empty(el('jobs'), t('대기 중인 요청이 없습니다'), t('새 승인 요청이 들어오면 여기에 표시됩니다.'));
    if (jobs.length === pending) empty(el('history'), t('아직 승인 이력이 없습니다'), t('승인·거부된 요청의 상태와 결과가 여기에 표시됩니다.'));
    rendered = fingerprint;
    }
    el('connection').classList.add('connected'); el('connection-text').textContent = t('연결됨');
    el('updated').textContent = `${t('마지막 갱신')} ${new Date().toLocaleTimeString(locale)} · ${t('10초마다 갱신')}`; error();
    if (!polling) polling = setInterval(() => { if (!document.hidden) load(); }, 10000);
  } catch (e) {
    error(e.message); el('connection').classList.remove('connected'); el('connection-text').textContent = t('연결 확인 필요');
    clearInterval(polling); polling = null;
  } finally { loading = false; el('load').disabled = false; }
}
el('load').onclick = load;
el('token').addEventListener('keydown', event => { if (event.key === 'Enter') load(); });
empty(el('jobs'), t('요청 목록을 연결해 주세요'), t('관리자 토큰을 입력하고 요청 조회를 누르세요.'));
empty(el('history'), t('처리 이력을 한눈에'), t('실행 중인 요청부터 완료된 결과까지 확인할 수 있습니다.'));
