export function createWebView({ document, i18n }) {
  const { t, korean, locale, states, kinds } = i18n;
  const el = id => document.getElementById(id);
  const records = new Map();
  let handlers;
  function text(parent, tag, value, className = '') {
    const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
  }
  function empty(title, note) {
    const box = document.createElement('div'); box.className = 'empty';
    text(box, 'span', '—', 'empty-mark'); text(box, 'strong', title); text(box, 'p', note); return box;
  }
  const placeholders = {
    pending: empty(t('대기 중인 요청이 없습니다'), t('새 승인 요청이 들어오면 여기에 표시됩니다.')),
    history: empty(t('아직 승인 이력이 없습니다'), t('승인·거부된 요청의 상태와 결과가 여기에 표시됩니다.')),
  };
  function createRecord(job, deciding, previous) {
    const waiting = job.state === 'pending';
    const box = document.createElement(waiting ? 'article' : 'details');
    box.className = 'request' + (waiting ? '' : ' history-item'); box.dataset.requestId = job.id;
    const command = job.kind === 'command' ? job.command : JSON.stringify(job.operation, null, 2);
    let body = box;
    if (!waiting) {
      box.open = previous?.node.open ?? false;
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
    const actions = text(body, 'div', '', 'actions'), buttons = [];
    if (waiting) for (const action of ['approve', 'deny']) {
      const button = text(actions, 'button', t(action === 'approve' ? '승인·실행' : '거부'), action === 'approve' ? 'primary' : 'secondary reject');
      button.disabled = deciding; button.onclick = () => handlers.decide(job.id, action); buttons.push(button);
    }
    if (job.result) {
      text(body, 'p', t('실행 결과'), 'output-label');
      const blocks = job.result.content?.filter(x => x.type === 'text');
      text(body, 'pre', blocks?.length ? blocks.map(x => x.text ?? '').join('\n') : JSON.stringify(job.result.structuredContent ?? job.result, null, 2), 'output');
    }
    if (job.auditError) text(body, 'p', job.auditError, 'error');
    if (job.state === 'completed' && job.kind === 'download') {
      const button = text(actions, 'button', t('파일 저장'), 'secondary'); button.onclick = () => handlers.download(job.id);
    }
    if (!actions.childElementCount) actions.remove();
    return { node: box, fingerprint: JSON.stringify(job), buttons };
  }
  function reconcile(parent, desired) {
    const wanted = new Set(desired);
    for (const node of [...parent.children]) if (!wanted.has(node)) node.remove();
    // Insert new/changed nodes around surviving nodes; do not detach unaffected requests.
    let cursor = parent.firstChild;
    for (const node of desired) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
  }
  function render(jobs, deciding = false) {
    const live = new Set(jobs.map(job => job.id)), pending = [], history = [];
    for (const [id, record] of records) if (!live.has(id)) { record.node.remove(); records.delete(id); }
    for (const job of [...jobs].reverse()) {
      let record = records.get(job.id);
      if (record?.fingerprint !== JSON.stringify(job)) {
        const previous = record; record = createRecord(job, deciding, previous);
        previous?.node.remove(); records.set(job.id, record);
      }
      for (const button of record.buttons) button.disabled = deciding;
      (job.state === 'pending' ? pending : history).push(record.node);
    }
    reconcile(el('jobs'), pending.length ? pending : [placeholders.pending]);
    reconcile(el('history'), history.length ? history : [placeholders.history]);
    el('pending-count').textContent = pending.length; el('history-count').textContent = history.length;
  }
  function initialize(actions) {
    handlers = actions;
    document.documentElement.lang = korean ? 'ko' : 'en';
    document.title = korean ? 'SSH 승인 · Approval Portal' : 'SSH approvals · Approval Portal';
    if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    el('token').placeholder = el('token').ariaLabel = t('관리자 토큰');
    el('load').onclick = actions.load; el('logout').onclick = actions.logout;
    el('token').addEventListener('keydown', event => { if (event.key === 'Enter') actions.load(); });
    el('jobs').replaceChildren(empty(t('요청 목록을 연결해 주세요'), t('관리자 토큰을 입력하고 요청 조회를 누르세요.')));
    el('history').replaceChildren(empty(t('처리 이력을 한눈에'), t('실행 중인 요청부터 완료된 결과까지 확인할 수 있습니다.')));
    if (actions.accessMode) {
      el('token').hidden = true; el('logout').hidden = false;
      el('auth-label').textContent = t('본인 계정으로 연결됨'); el('auth-label').removeAttribute('for');
      el('auth-note').textContent = t('Cloudflare Access에서 확인한 본인 계정으로 요청을 처리합니다.');
    }
  }
  return {
    initialize, render,
    token: () => el('token').value,
    unauthorized: () => { el('sign-in').hidden = false; },
    error: (message = '') => { el('error').textContent = message; el('error').hidden = !message; },
    loading: busy => { el('load').disabled = busy; },
    deciding: busy => { for (const record of records.values()) for (const button of record.buttons) button.disabled = busy; },
    connected: () => {
      el('connection').classList.add('connected'); el('connection-text').textContent = t('연결됨'); el('logout').hidden = false; el('sign-in').hidden = true;
      el('updated').textContent = `${t('마지막 갱신')} ${new Date().toLocaleTimeString(locale)} · ${t('10초마다 갱신')}`;
    },
    disconnected: () => { el('connection').classList.remove('connected'); el('connection-text').textContent = t('연결 확인 필요'); },
    signedOut: () => {
      el('token').value = ''; el('jobs').replaceChildren(); el('history').replaceChildren(); records.clear();
      el('pending-count').textContent = el('history-count').textContent = '0'; el('logout').disabled = el('load').disabled = true;
    },
  };
}
