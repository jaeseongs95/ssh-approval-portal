import { renderDecision, recordedApprovalMode, requestContext } from '../../ui/src/decision.js';
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
  let historyOffset=0, historyAnchor, latestJobs=[], latestDeciding=false, pager;
  let historySearch, historyFilter, historyFrom, historyTo, historyDateError, historyRange={};
  const historyPageSize=20;
  function updateHistoryRange() {
    const boundary=(input,nextDay=false)=>{
      if(!input?.value)return undefined;
      const date=new Date(input.value+'T00:00:00');
      if(nextDay)date.setDate(date.getDate()+1);
      return date.getTime();
    };
    const from=boundary(historyFrom),to=boundary(historyTo,true);
    const invalid=[historyFrom,historyTo].some(input=>input?.validity.badInput)||[from,to].some(value=>value!==undefined&&!Number.isFinite(value));
    const reversed=from!==undefined&&to!==undefined&&from>=to;
    const message=invalid?(korean?'올바른 날짜를 입력해 주세요.':'Enter a valid date.'):reversed?(korean?'종료일은 시작일과 같거나 이후여야 합니다.':'End date must be on or after start date.') : '';
    historyRange={from,to,invalid:!!message};
    if(historyDateError){historyDateError.textContent=message;historyDateError.hidden=!message;}
    for(const input of [historyFrom,historyTo])input?.setAttribute('aria-invalid',String(!!message));
  }
  const matchesHistory=job=>{
    const query=historySearch?.value.trim().toLowerCase()??'',filter=historyFilter?.value??'';
    const {from,to,invalid}=historyRange,hasRange=from!==undefined||to!==undefined;
    return !invalid&&(!hasRange||(Number.isFinite(job.createdAt)&&(from===undefined||job.createdAt>=from)&&(to===undefined||job.createdAt<to)))&&!['pending','running','evaluating'].includes(job.state)&&(!filter||job.state===filter)&&(!query||[job.id,job.command,job.kind==='command'?'':JSON.stringify(job.operation),job.targetDisplayName,job.targetId].join(' ').toLowerCase().includes(query));
  };
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
    filteredHistory: empty(korean?'검색 조건에 맞는 승인 이력이 없습니다':'No approval history matches your filters',korean?'조회기간·검색어·상태·대상 서버를 확인해 주세요.':'Check the date range, search, status and target server.'),
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
      if (recordedApprovalMode(job) === 'automatic') text(head, 'span', korean ? '자동승인' : 'Automatically approved', 'badge automatic-approval');
      text(head, 'span', states[job.state] ?? job.state, `badge ${job.state}`);
      text(summary, 'span', command, 'preview'); body = text(box, 'div', '', 'history-body');
    } else {
      const head = text(box, 'div', '', 'request-top'); text(head, 'span', kinds[job.kind] ?? job.kind, 'kind'); text(head, 'span', t('승인 대기'), 'badge pending');
    }
    text(body, 'p', `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${job.targetDisplayName ?? targetName}${job.targetId ? ` [${job.targetId}]` : ''} (${job.target})`, 'target');
    if (job.targetId) text(body, 'p', `${t('설정 revision')} · ${job.targetRevision} / ${t('호스트 키')} · ${job.hostKey}`, 'target'); text(body, 'pre', command, 'command');
    if (job.kind === 'command' && requestContext(job, korean)) { const context = text(body, 'details', ''); text(context, 'summary', korean ? '요청자가 제공한 작업 설명' : 'Caller-provided context'); text(context, 'p', requestContext(job, korean)); }
    if (job.decision) renderDecision(document, body, job.decision, korean, job);
    const meta = text(body, 'div', '', 'meta'); text(meta, 'span', `${t('요청')} ${job.id}`, 'request-id');
    const time = waiting ? job.expiresAt : job.finishedAt ?? job.createdAt;
    text(meta, 'span', `${t(waiting ? '만료' : job.finishedAt ? '처리 완료' : '요청')} ${new Date(time).toLocaleString(locale)}`);
    const actions = text(body, 'div', '', 'actions'), buttons = [];
    if (waiting) for (const action of ['approve', 'deny']) {
      const button = text(actions, 'button', t(action === 'approve' ? '승인·실행' : '거부'), action === 'approve' ? 'primary' : 'secondary reject');
      button.disabled = deciding; button.onclick = () => handlers.decide(job.id, action); buttons.push(button);
    }
    const output = job.kind === 'command' && job.result?.structuredContent?.output;
    if (output) {
      text(body, 'p', korean ? `저장된 실행 결과 · ${output.bytes ?? 0}바이트 · ${output.state}` : `Stored result · ${output.bytes ?? 0} bytes · ${output.state}`, 'output-label');
      text(body, 'p', korean ? '필요할 때만 내용을 읽습니다. SSH 전체 출력의 완전성은 확인되지 않았습니다.' : 'Load only when needed. Complete SSH capture is not guaranteed.', 'target');
      const area = text(body, 'div', '');
      const load = async (offset = 0) => {
        if (!box.isConnected) return;
        button.disabled = true;
        try {
          const page = await handlers.output(output.id, offset);
          if (!box.isConnected) return;
          area.replaceChildren(); text(area, 'p', `${page.offsetBytes}–${page.nextOffset} / ${page.totalBytes} bytes`); text(area, 'pre', page.text, 'output');
          button.textContent = page.eof ? (korean ? '처음부터 보기' : 'Read from start') : (korean ? '다음 부분' : 'Next page');
          button.onclick = () => load(page.eof ? 0 : page.nextOffset);
        } catch { if (box.isConnected) { area.replaceChildren(); text(area, 'p', korean ? '출력을 읽을 수 없습니다. 만료·연결 상태를 확인하세요. 명령은 다시 실행하지 않습니다.' : 'Output unavailable. Check expiry/connection; the command is not rerun.', 'error'); } }
        finally { if (box.isConnected) button.disabled = false; }
      };
      const button = text(actions, 'button', korean ? '출력 보기' : 'View output', 'secondary'); button.disabled = output.state !== 'ready'; button.onclick = () => load();
    } else if (job.result) {
      text(body, 'p', t('실행 결과'), 'output-label');
      const blocks = job.result.content?.filter(x => x.type === 'text');
      text(body, 'pre', blocks?.length ? blocks.map(x => x.text ?? '').join('\n') : JSON.stringify(job.result.structuredContent ?? job.result, null, 2), 'output');
    }
    if (job.auditError) text(body, 'p', job.auditError, 'error');
    if (job.state === 'completed' && job.kind === 'download') {
      text(body, 'p', korean ? '서버 파일 준비 완료 · PC 저장이나 에이전트 수신은 아직 확인되지 않았습니다. 아래 파일 저장 버튼을 사용하세요.' : 'Server file ready. Device save or agent receipt is not confirmed. Use Save file below.', 'auth-note');
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
      return [scoped.length, ...['pending', 'evaluating', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown'].map(state => scoped.filter(job => job.state === state).length)];
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
        const labels=['보관 중', '승인 대기', '평가 중', '실행 중', '완료', '실패', '거부', '만료', '결과 불명'];
        text(node, 'span', labels.map((label,index)=>`${t(label)} ${values[index]}`).join(' · '), 'server-counts');
        node.onclick = () => { if (changeTarget && target.id !== (el('target-filter')?.value || '')) { el('target-filter').value = target.id; changeTarget(); } };
        if (!changeTarget) node.disabled = true;
        record = { node, fingerprint }; serverRecords.set(target.id, record);
      }
      return record.node;
    });
    reconcile(root, nodes); el('overview-section').hidden = false;
  }
  function render(jobs, deciding = false) {
    latestJobs=jobs; latestDeciding=deciding;
    updateHistoryRange();
    overview(jobs);
    const selected = el('target-filter')?.value;
    const visible = selected ? jobs.filter(job => (job.targetId ?? 'default') === selected) : jobs;
    const ordered=[...visible].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id));
    const historyJobs=ordered.filter(matchesHistory);
    if(historyAnchor){const anchor=historyJobs.findIndex(job=>job.id===historyAnchor);if(anchor>=0)historyOffset=anchor;else historyAnchor=undefined;}
    historyOffset=Math.min(historyOffset,Math.max(0,historyJobs.length-1));
    const historySlice=historyJobs.slice(historyOffset,historyOffset+historyPageSize),pageIds=new Set(historySlice.map(job=>job.id));
    const live = new Set(visible.map(job => job.id)), pending = [], running = [], history = [];
    for (const [id, record] of records) if (!live.has(id)) { record.node.remove(); records.delete(id); }
    // Aggregate queues arrive grouped by target, so insertion order is not chronology.
    for (const job of ordered) {
      if(!['pending','running','evaluating'].includes(job.state)&&!pageIds.has(job.id))continue;
      let record = records.get(job.id);
      if (record?.fingerprint !== JSON.stringify(job)) {
        const previous = record; record = createRecord(job, deciding, previous);
        previous?.node.remove(); records.set(job.id, record);
      }
      for (const button of record.buttons) button.disabled = deciding;
      (job.state === 'pending' ? pending : ['running', 'evaluating'].includes(job.state) ? running : history).push(record.node);
    }
    reconcile(el('jobs'), pending.length ? pending : [placeholders.pending]);
    const filtered=historySearch?.value.trim()||historyFilter?.value||historyFrom?.value||historyTo?.value||historyRange.invalid||selected;
    reconcile(el('history'), history.length ? history : [filtered?placeholders.filteredHistory:placeholders.history]);
    if (el('running')) reconcile(el('running'), running.length ? running : [placeholders.running]);
    el('pending-count').textContent = pending.length; el('history-count').textContent = historyJobs.length;
    if (el('running-count')) el('running-count').textContent = running.length;
    const navigation=el('history-pagination');
    if(navigation){
      if(!pager){
        const previous=text(navigation,'button',korean?'이전':'Previous','secondary'),label=text(navigation,'span',''),next=text(navigation,'button',korean?'다음':'Next','secondary');
        label.setAttribute('aria-live','polite');
        const move=delta=>{historyOffset=Math.max(0,historyOffset+delta);historyAnchor=historyJobsAtOffset();render(latestJobs,latestDeciding);};
        const historyJobsAtOffset=()=>{const target=el('target-filter')?.value;return [...latestJobs].filter(job=>(!target||(job.targetId??'default')===target)&&matchesHistory(job)).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id))[historyOffset]?.id;};
        previous.onclick=()=>move(-historyPageSize);next.onclick=()=>move(historyPageSize);pager={previous,label,next};
      }
      navigation.hidden=historyJobs.length<=historyPageSize;
      pager.label.textContent=`${historyOffset+1}–${Math.min(historyOffset+historyPageSize,historyJobs.length)} / ${historyJobs.length}`;
      pager.previous.disabled=deciding||historyOffset===0;pager.next.disabled=deciding||historyOffset+historyPageSize>=historyJobs.length;
    }
  }
  function initialize(actions) {
    handlers = actions;
    document.documentElement.lang = korean ? 'ko' : 'en';
    document.title = `${bridgeName} · ${targetName} · ${korean ? 'SSH 승인' : 'SSH approvals'}`;
    const serverIdentity = el('server-identity');
    if (serverIdentity) { serverIdentity.textContent = identity; serverIdentity.ariaLabel = t('서버 식별'); }
    if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    document.querySelector?.('.admin-nav')?.setAttribute('aria-label', korean ? '관리 메뉴' : 'Management navigation');
    el('history-pagination')?.setAttribute('aria-label', korean ? '승인 이력 페이지' : 'History pages');
    el('token').placeholder = el('token').ariaLabel = t('관리자 토큰');
    el('load').onclick = actions.load; el('logout').onclick = actions.logout;
    const filters=document.createElement('div');filters.className='history-filters';
    const searchLabel=text(filters,'label',korean?'이력 검색':'Search history');historySearch=text(searchLabel,'input','');historySearch.type='search';historySearch.maxLength=200;historySearch.placeholder=korean?'명령·요청 ID·서버 검색':'Search command, request ID or server';
    const filterLabel=text(filters,'label',korean?'처리 상태':'Request status');historyFilter=text(filterLabel,'select','');historyFilter.setAttribute('aria-label',korean?'처리 상태':'Request status');
    for(const value of ['', 'completed','failed','denied','expired','unknown']){const option=text(historyFilter,'option',value?states[value]:(korean?'전체 상태':'All statuses'));option.value=value;}
    const dateInput=label=>{const input=text(text(filters,'label',label),'input','');input.type='date';input.setAttribute('aria-describedby','history-date-note history-date-error');return input;};
    historyFrom=dateInput(korean?'시작일':'Start date');historyTo=dateInput(korean?'종료일':'End date');
    const clearDates=text(filters,'button',korean?'기간 초기화':'Clear dates','secondary');clearDates.type='button';
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const note=text(filters,'p',korean?`요청 생성일 기준 · 현지시간 (${zone}) · 시작일·종료일 포함`:`Request creation date · Local time (${zone}) · Both dates included`,'history-date-note');note.id='history-date-note';
    historyDateError=text(filters,'p','','error history-date-error');historyDateError.id='history-date-error';historyDateError.setAttribute('role','alert');historyDateError.hidden=true;
    el('history').before(filters);
    const filterChanged=()=>{historyOffset=0;historyAnchor=undefined;render(latestJobs,latestDeciding);};
    historySearch.oninput=historyFilter.onchange=historyFrom.oninput=historyTo.oninput=filterChanged;
    clearDates.onclick=()=>{historyFrom.value=historyTo.value='';filterChanged();};
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
