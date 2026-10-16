import { decisionText } from '../../ui/src/decision.js';
export function createWebView({ document, i18n }) {
  const { t, korean, locale, states, kinds } = i18n;
  const el = id => document.getElementById(id);
  const bridgeName = document.body.dataset.bridgeDisplayName || document.location?.host || 'SSH Approval Portal';
  const targetName = document.body.dataset.targetDisplayName || 'SSH';
  const identity = `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${targetName}`;
  const multiTarget = document.body.dataset.multiTarget === 'true';
  let selectionRevision = 0;
  const records = new Map();
  const serverRecords = new Map();
  let targetList = [], changeTarget;
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
    running: empty(t('실행 중인 요청이 없습니다'), t('승인 후 실행 중인 명령과 파일 전송이 표시됩니다.')),
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
      text(head, 'span', `${job.targetDisplayName ?? targetName}${job.targetId ? ` [${job.targetId}]` : ''}`, 'summary-target');
      text(head, 'span', states[job.state] ?? job.state, `badge ${job.state}`);
      text(summary, 'span', command, 'preview'); body = text(box, 'div', '', 'history-body');
    } else {
      const head = text(box, 'div', '', 'request-top'); text(head, 'span', kinds[job.kind] ?? job.kind, 'kind'); text(head, 'span', t('승인 대기'), 'badge pending');
    }
    text(body, 'p', `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${job.targetDisplayName ?? targetName}${job.targetId ? ` [${job.targetId}]` : ''} (${job.target})`, 'target');
    if (job.targetId) text(body, 'p', `${t('설정 revision')} · ${job.targetRevision} / ${t('호스트 키')} · ${job.hostKey}`, 'target'); text(body, 'pre', command, 'command');
    if (job.decision) text(body, 'p', decisionText(job.decision, korean), 'target');
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
  function overview(jobs) {
    const root = el('server-overview');
    if (!root) return;
    const counts = id => {
      const scoped = id === undefined ? jobs : jobs.filter(job => (job.targetId ?? 'default') === id);
      return ['pending', 'running', 'failed'].map(state => scoped.filter(job => job.state === state).length);
    };
    const selected = el('target-filter')?.value || '';
    const entries = [{ id: '', displayName: t('전체 대상'), enabled: true }, ...targetList];
    const nodes = entries.map(target => {
      const values = counts(target.id || undefined), fingerprint = JSON.stringify([target, values, selected]);
      let record = serverRecords.get(target.id);
      if (record?.fingerprint !== fingerprint) {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'server-card'; node.dataset.targetId = target.id;
        node.setAttribute('aria-pressed', String(target.id === selected));
        text(node, 'strong', target.displayName);
        if (target.id) text(node, 'span', `${target.id} · ${t(target.enabled ? '등록됨' : '사용 중지')}`, 'server-id');
        text(node, 'span', `${t('승인 대기')} ${values[0]} · ${t('실행 중')} ${values[1]} · ${t('실패')} ${values[2]}`, 'server-counts');
        node.onclick = () => { if (changeTarget && target.id !== (el('target-filter')?.value || '')) { el('target-filter').value = target.id; changeTarget(); } };
        if (!changeTarget) node.disabled = true;
        record = { node, fingerprint }; serverRecords.set(target.id, record);
      }
      return record.node;
    });
    reconcile(root, nodes); el('overview-section').hidden = false;
  }
  function render(jobs, deciding = false) {
    overview(jobs);
    const selected = el('target-filter')?.value;
    const visible = selected ? jobs.filter(job => (job.targetId ?? 'default') === selected) : jobs;
    const live = new Set(visible.map(job => job.id)), pending = [], running = [], history = [];
    for (const [id, record] of records) if (!live.has(id)) { record.node.remove(); records.delete(id); }
    // Aggregate queues arrive grouped by target, so insertion order is not chronology.
    for (const job of [...visible].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id))) {
      let record = records.get(job.id);
      if (record?.fingerprint !== JSON.stringify(job)) {
        const previous = record; record = createRecord(job, deciding, previous);
        previous?.node.remove(); records.set(job.id, record);
      }
      for (const button of record.buttons) button.disabled = deciding;
      (job.state === 'pending' ? pending : ['running', 'evaluating'].includes(job.state) ? running : history).push(record.node);
    }
    reconcile(el('jobs'), pending.length ? pending : [placeholders.pending]);
    reconcile(el('history'), history.length ? history : [placeholders.history]);
    if (el('running')) reconcile(el('running'), running.length ? running : [placeholders.running]);
    el('pending-count').textContent = pending.length; el('history-count').textContent = history.length;
    if (el('running-count')) el('running-count').textContent = running.length;
  }
  function initialize(actions) {
    handlers = actions;
    document.documentElement.lang = korean ? 'ko' : 'en';
    document.title = `${bridgeName} · ${targetName} · ${korean ? 'SSH 승인' : 'SSH approvals'}`;
    const serverIdentity = el('server-identity');
    if (serverIdentity) { serverIdentity.textContent = identity; serverIdentity.ariaLabel = t('서버 식별'); }
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
    initialize, render, multiTarget,
    target: () => el('target-filter')?.value || undefined,
    selectionRevision: () => selectionRevision,
    targets(data, changed) {
      targetList = data.targets;
      const select = el('target-filter'); select.replaceChildren();
      const all = text(select, 'option', t('전체 대상')); all.value = '';
      for (const target of data.targets) { const option = text(select, 'option', `${target.displayName} (${target.id})${target.enabled ? '' : ` · ${t('사용 중지')}`}`); option.value = target.id; }
      select.ariaLabel = t('대상 서버'); el('target-filter-label').hidden = false;
      const identify = () => {
        const target = data.targets.find(target => target.id === select.value);
        const name = target ? `${target.displayName} [${target.id}]` : t('전체 대상');
        document.title = `${bridgeName} · ${name} · ${korean ? 'SSH 승인' : 'SSH approvals'}`;
        el('server-identity').textContent = `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${name}`;
      };
      identify(); changeTarget = select.onchange = () => {
        selectionRevision++; render([]); identify();
        if (el('overview-section')) el('overview-section').hidden = true;
        el('error').textContent = ''; el('error').hidden = true; changed();
      };
    },
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
      el('running')?.replaceChildren(); el('server-overview')?.replaceChildren(); serverRecords.clear(); targetList = [];
      if (el('overview-section')) el('overview-section').hidden = true;
      if (el('target-filter-label')) el('target-filter-label').hidden = true;
      if (el('running-count')) el('running-count').textContent = '0';
      el('pending-count').textContent = el('history-count').textContent = '0'; el('logout').disabled = el('load').disabled = true;
    },
  };
}
