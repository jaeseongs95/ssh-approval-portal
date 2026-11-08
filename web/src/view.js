import { recordedApprovalMode } from '../../ui/src/decision.js';
import { createRequestDetail } from './request-detail.js';
export function createWebView({ document, i18n }) {
  const { t, korean, locale, states, kinds, formatNumber } = i18n;
  const el = id => document.getElementById(id);
  const bridgeName = document.body.dataset.bridgeDisplayName || document.location?.host || 'SSH Approval Portal';
  const targetName = document.body.dataset.targetDisplayName || 'SSH';
  const identity = `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${targetName}`;
  const multiTarget = document.body.dataset.multiTarget === 'true';
  let selectionRevision = 0;
  const records = new Map();
  const serverRecords = new Map();
  let targetList = [], changeTarget, policyAction, commandImportAction;
  const scrolls = new Map(); let lastTarget = '';
  function identify() {
    const page = document.body.dataset.page, settings = page === 'settings';
    const selected = targetList.find(item => item.id === el('target-filter')?.value);
    const name = settings ? (korean ? '서버 설정 · 정책 대상은 아래에서 선택' : 'Server settings · select the policy target below') : page === 'bridge' ? (korean ? '중계기 전체 설정' : 'Bridge settings') : page === 'preferences' ? (korean ? '화면 설정' : 'Display preferences') : selected ? `${selected.displayName} [${selected.id}]` : multiTarget ? t('전체 대상') : targetName;
    document.title = `${bridgeName} · ${name} · ${korean ? 'SSH 승인' : 'SSH approvals'}`;
    if (el('server-identity')) el('server-identity').textContent = `${t('중계기')} · ${bridgeName} / ${name}`;
  }
  let handlers, detail, returnButton, requestOriginPath = '/';
  const announce = message => { const node = el('request-announcement'); if (node && node.textContent !== message) node.textContent = message; };
  let historyOffset=0, historyAnchor, latestJobs=[], latestDeciding=false, pager;
  let historySearch, historyFilter, historyFrom, historyTo, historyDateError, historyRange={};
  let historyResult, historyCursor, historyPrevious = [], historyBusy = false, historyFailure = false, historyStatus, historyCoverage;
  const historyPageSize=20;
  function historyQuery() {
    updateHistoryRange();
    const query = new URLSearchParams();
    if (historyRange.from !== undefined) query.set('from', historyRange.from);
    if (historyRange.to !== undefined) query.set('to', historyRange.to);
    if (el('target-filter')?.value) query.set('target', el('target-filter').value);
    if (historyFilter?.value) query.set('state', historyFilter.value);
    if (historySearch?.value.trim()) query.set('q', historySearch.value.trim());
    if (historyCursor) query.set('cursor', historyCursor);
    return { query: query.toString(), valid: !historyRange.invalid };
  }
  function queryHistory(reset = false) {
    if (reset) { historyCursor = undefined; historyPrevious = []; historyResult = undefined; }
    historyBusy = true; historyFailure = false; el('history')?.setAttribute('aria-busy', 'true');
    if (historyStatus) historyStatus.textContent = korean ? '이력을 조회하는 중입니다.' : 'Loading history.';
    render(latestJobs,latestDeciding);
    handlers?.history?.();
  }
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
    return !invalid&&(!hasRange||(Number.isFinite(job.createdAt)&&(from===undefined||job.createdAt>=from)&&(to===undefined||job.createdAt<to)))&&!['pending','queued','running','evaluating'].includes(job.state)&&(!filter||job.state===filter)&&(!query||[job.id,job.command,job.kind==='command'?'':JSON.stringify(job.operation),job.targetDisplayName,job.targetId].join(' ').toLowerCase().includes(query));
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
    loadingHistory: empty(korean?'승인 이력을 조회하고 있습니다':'Loading approval history',korean?'조회 조건과 보관 기록을 확인하고 있습니다.':'Checking filters and retained records.'),
    failedHistory: empty(korean?'승인 이력을 조회하지 못했습니다':'Approval history unavailable',korean?'오류를 확인하고 요청 조회를 다시 누르세요. 실행 요청은 반복하지 않습니다.':'Check the error and refresh requests. Execution is not repeated.'),
    incompleteHistory: empty(korean?'일부 기록이 제외되어 조회가 불완전합니다':'History results are incomplete',korean?'표시할 수 있는 기록이 없습니다. 기록 정보나 현재 연결을 확인하지 못한 일부 기록이 제외되어, 조회 대상의 기록이 없다고 판단할 수 없습니다.':'No displayable records were found. Some records were excluded because their metadata or current connection could not be verified; this does not establish that no history exists.'),
  };
  function createRecord(job) {
    const node = document.createElement('article'); node.className = 'request request-row'; node.dataset.requestId = job.id;
    const head = text(node, 'div', '', 'request-top'), kind = text(head, 'span', '', 'kind'), badge = text(head, 'span');
    const target = text(node, 'p', '', 'target'); target.id = 'request-target-' + job.id;
    const command = text(node, 'pre', '', 'command');
    const button = text(node, 'button', korean ? '요청 상세 보기' : 'View request details', 'secondary'); button.type = 'button'; button.dataset.requestDetail = job.id; button.setAttribute('aria-describedby', target.id); button.setAttribute('aria-controls', 'request-detail'); button.setAttribute('aria-expanded','false');
    const record = { node, button, update(value) {
      record.job = value; node.dataset.state = value.state;
      kind.textContent = kinds[value.kind] ?? value.kind;
      badge.className = `badge ${value.state}`; badge.textContent = `${states[value.state] ?? value.state}${recordedApprovalMode(value) === 'automatic' ? (korean ? ' · 자동승인' : ' · Automatic') : ''}`;
      target.textContent = `${value.targetDisplayName ?? targetName}${value.targetId ? ` [${value.targetId}]` : ''} · ${value.target} · ${t('요청')} ${value.id}`;
      const content = value.kind === 'command' ? value.command : JSON.stringify(value.operation, null, 2);
      if (command.textContent !== content) command.textContent = content;
      record.fingerprint = JSON.stringify(value);
    } };
    button.onclick = () => { requestOriginPath = document.body.dataset.page === 'history' ? '/history' : '/'; detail?.select(record.job, button); }; record.update(job); return record;
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
      return [scoped.length, ...['pending', 'evaluating', 'queued', 'running', 'completed', 'failed', 'denied', 'expired', 'unknown'].map(state => scoped.filter(job => job.state === state).length)];
    };
    const selected = el('target-filter')?.value || '';
    const entries = [{ id: '', displayName: t('전체 대상'), enabled: true }, ...targetList];
    const nodes = entries.map(target => {
      const values = counts(target.id || undefined), fingerprint = JSON.stringify([target, values, selected]);
      let record = serverRecords.get(target.id);
      if (!record) {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'server-card'; node.dataset.targetId = target.id;
        const name = text(node, 'strong', target.displayName), identity = text(node, 'span', '', 'server-id'), counts = text(node, 'span', '', 'server-counts');
        node.onclick = () => { if (changeTarget && target.id !== (el('target-filter')?.value || '')) { el('target-filter').value = target.id; changeTarget(); } };
        record = { node, name, identity, counts }; serverRecords.set(target.id, record);
      }
      if (record.fingerprint !== fingerprint) {
        record.node.setAttribute('aria-pressed', String(target.id === selected)); record.name.textContent = target.displayName;
        record.identity.textContent = target.id ? `${target.id}${target.platform ? ' · ' + (target.platform === 'windows' ? 'Windows' : 'Linux') : ''} · ${t(target.enabled ? '등록됨' : '사용 중지')}` : '';
        const labels=['보관 중', '승인 대기', '평가 중', '실행 대기', '실행 중', '완료', '실패', '거부', '만료', '결과 불명'];
        record.counts.textContent = labels.map((label,index)=>`${t(label)} ${values[index]}`).join(' · ');
        record.node.disabled = !changeTarget; record.fingerprint = fingerprint;
      }
      return record.node;
    });
    reconcile(root, nodes); el('overview-section').hidden = false;
  }
  function render(jobs, deciding = false) {
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) { render([]); throw Error(korean ? '중복된 요청 ID가 있어 승인을 중단했습니다.' : 'Duplicate request IDs: approvals are unavailable.'); }
    latestJobs=jobs; latestDeciding=deciding;
    updateHistoryRange();
    overview(jobs);
    const selected = el('target-filter')?.value;
    const visible = selected ? jobs.filter(job => (job.targetId ?? 'default') === selected) : jobs;
    const ordered=[...visible].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id));
    const latestById = new Map(jobs.map(job => [job.id, job]));
    const historyJobs = historyResult ? historyResult.items.map(job => latestById.has(job.id) ? { ...job, ...latestById.get(job.id) } : job).filter(matchesHistory) : handlers?.history ? [] : ordered.filter(matchesHistory);
    if(historyAnchor){const anchor=historyJobs.findIndex(job=>job.id===historyAnchor);if(anchor>=0)historyOffset=anchor;else historyAnchor=undefined;}
    historyOffset=Math.min(historyOffset,Math.max(0,historyJobs.length-1));
    const historySlice=historyResult ? historyJobs : historyJobs.slice(historyOffset,historyOffset+historyPageSize),pageIds=new Set(historySlice.map(job=>job.id));
    const combined = [...new Map([...historySlice, ...jobs].map(job => [job.id, job])).values()];
    const live = new Set(combined.map(job => job.id)), pending = [], running = [], history = [];
    for (const [id, record] of records) if (!live.has(id)) { record.node.remove(); records.delete(id); }
    // Aggregate queues arrive grouped by target, so insertion order is not chronology.
    const listJobs = [...new Map([...ordered.filter(job => ['pending','queued','running','evaluating'].includes(job.state)), ...historySlice].map(job => [job.id, job])).values()];
    for (const job of listJobs) {
      if(!['pending','queued','running','evaluating'].includes(job.state)&&!pageIds.has(job.id))continue;
      let record = records.get(job.id);
      if (record?.fingerprint !== JSON.stringify(job)) {
        if (record) record.update(job); else { record = createRecord(job); records.set(job.id, record); }
      }
      (job.state === 'pending' ? pending : ['queued', 'running', 'evaluating'].includes(job.state) ? running : history).push(record.node);
    }
    reconcile(el('jobs'), pending.length ? pending : [placeholders.pending]);
    const filtered=historySearch?.value.trim()||historyFilter?.value||historyFrom?.value||historyTo?.value||historyRange.invalid||selected;
    reconcile(el('history'), history.length ? history : [historyBusy?placeholders.loadingHistory:historyFailure?placeholders.failedHistory:historyResult?.coverage?.metadataIncomplete?placeholders.incompleteHistory:filtered?placeholders.filteredHistory:placeholders.history]);
    if (el('running')) reconcile(el('running'), running.length ? running : [placeholders.running]);
    el('pending-count').textContent = pending.length; el('history-count').textContent = historyJobs.length;
    if (el('running-count')) el('running-count').textContent = running.length;
    const workSummary = el('work-summary');
    if (workSummary) {
      const summaryText = korean ? `승인 대기 ${pending.length} · 처리 중 ${running.length} · 보관 이력 ${historyJobs.length}` : `${pending.length} pending · ${running.length} in progress · ${historyJobs.length} retained`;
      let chip = workSummary.firstElementChild;
      if (!chip || chip.tagName !== 'SPAN') {
        workSummary.replaceChildren();
        chip = text(workSummary, 'span', summaryText, 'summary-chip');
      } else if (chip.textContent !== summaryText) {
        chip.textContent = summaryText;
      }
    }
    detail?.update(combined, deciding);
    const navigation=el('history-pagination');
    if(navigation){
      if(!pager){
        const previous=text(navigation,'button',korean?'이전':'Previous','secondary'),label=text(navigation,'span',''),next=text(navigation,'button',korean?'다음':'Next','secondary');
        label.setAttribute('aria-live','polite');
        const move=delta=>{historyOffset=Math.max(0,historyOffset+delta);historyAnchor=historyJobsAtOffset();render(latestJobs,latestDeciding);};
        const historyJobsAtOffset=()=>{const target=el('target-filter')?.value;return [...latestJobs].filter(job=>(!target||(job.targetId??'default')===target)&&matchesHistory(job)).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id))[historyOffset]?.id;};
        previous.onclick=()=>{ if (handlers?.history) { historyCursor=historyPrevious.pop();queryHistory(); } else move(-historyPageSize); };
        next.onclick=()=>{ if (handlers?.history) { historyPrevious.push(historyCursor);historyCursor=historyResult?.nextCursor;queryHistory(); } else move(historyPageSize); };pager={previous,label,next};
      }
      navigation.hidden=handlers?.history ? !historyPrevious.length&&!historyResult?.nextCursor : historyJobs.length<=historyPageSize;
      pager.label.textContent=handlers?.history ? (korean ? `${historyPrevious.length+1}페이지 · ${historyJobs.length}건 표시` : `Page ${historyPrevious.length+1} · ${historyJobs.length} shown`) : `${historyOffset+1}–${Math.min(historyOffset+historyPageSize,historyJobs.length)} / ${historyJobs.length}`;
      pager.previous.disabled=historyBusy||(handlers?.history ? !historyPrevious.length : historyOffset===0);pager.next.disabled=historyBusy||(handlers?.history ? !historyResult?.nextCursor : historyOffset+historyPageSize>=historyJobs.length);
    }
  }
  function initialize(actions) {
    handlers = actions;
    el('history').tabIndex = 0; el('history').setAttribute('role','region'); el('history').setAttribute('aria-labelledby','history-heading');
    detail = createRequestDetail({ document, i18n, bridgeName, targetName, targets: () => targetList, actions, policy: id => policyAction?.(id), importNames: input => commandImportAction?.(input), announce });
    const intro = document.querySelector?.('.intro');
    if (intro) {
      returnButton = text(intro,'button',korean?'원 요청으로 돌아가기':'Return to request','secondary');returnButton.type='button';returnButton.id='request-return';returnButton.hidden=true;
      returnButton.onclick=()=>document.dispatchEvent(new CustomEvent('admin-request-return',{detail:{path:requestOriginPath}}));
    }
    document.addEventListener?.('admin-scope-change', () => {
      identify(); const active = ['approvals','history'].includes(document.body.dataset.page);detail?.page(active);
      if(returnButton)returnButton.hidden=active||!detail?.selected();
    });
    document.documentElement.lang = korean ? 'ko' : 'en';
    document.documentElement.dir = i18n.dir ?? 'ltr';
    document.title = `${bridgeName} · ${targetName} · ${korean ? 'SSH 승인' : 'SSH approvals'}`;
    const serverIdentity = el('server-identity');
    if (serverIdentity) { serverIdentity.textContent = identity; serverIdentity.ariaLabel = t('서버 식별'); }
    if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    document.querySelector?.('.admin-nav')?.setAttribute('aria-label', korean ? '관리 메뉴' : 'Management navigation');
    el('server-workspace')?.setAttribute('aria-label', korean ? '서버 관리' : 'Server management');
    el('server-settings-tabs')?.setAttribute('aria-label', korean ? '서버 작업' : 'Server tasks');
    el('work-summary')?.setAttribute('aria-label', korean ? '요청 요약' : 'Request summary');
    el('request-close')?.setAttribute('aria-label', korean ? '요청 상세 닫기' : 'Close request details');
    el('history-pagination')?.setAttribute('aria-label', korean ? '승인 이력 페이지' : 'History pages');
    el('token').placeholder = el('token').ariaLabel = t('관리자 토큰');
    el('load').onclick = actions.load; el('logout').onclick = actions.logout;
    if (el('version-check')) el('version-check').onclick = () => actions.checkVersion?.(true);
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
    historyStatus = text(filters,'p','','policy-message');historyStatus.id='history-query-status';historyStatus.setAttribute('role','status');
    historyCoverage = text(filters,'p','','auth-note');historyCoverage.id='history-coverage';
    const filterChanged=()=>{historyOffset=0;historyAnchor=undefined;if(actions.history)queryHistory(true);else render(latestJobs,latestDeciding);};
    historySearch.oninput=historyFilter.onchange=historyFrom.oninput=historyTo.oninput=filterChanged;
    clearDates.onclick=()=>{historyFrom.value=historyTo.value='';filterChanged();};
    el('token').addEventListener('keydown', event => { if (event.key === 'Enter') actions.load(); });
    el('jobs').replaceChildren(empty(t('요청 목록을 연결해 주세요'), t('관리자 토큰을 입력하고 요청 조회를 누르세요.')));
    el('history').replaceChildren(empty(t('처리 이력을 한눈에'), t('실행 중인 요청부터 완료된 결과까지 확인할 수 있습니다.')));
    if (actions.accessMode) {
      el('token').hidden = true; el('logout').hidden = false;
      el('sign-in').textContent=korean?'관리자 다시 연결':'Reconnect administrator';
      el('sign-in').onclick=event=>{event.preventDefault();return actions.reconnect();};
      el('auth-label').textContent = t('본인 계정으로 연결됨'); el('auth-label').removeAttribute('for');
      el('auth-note').textContent = t(document.body.dataset.authMode === 'oidc' ? 'SSO에서 확인한 본인 계정으로 요청을 처리합니다.' : 'Cloudflare Access에서 확인한 본인 계정으로 요청을 처리합니다.');
    }
  }
  return {
    set openPolicy(action) { policyAction = action; },
    set importCommandNames(action) { commandImportAction = action; },
    uncertainDecisionMessage: () => korean ? '승인·거부 결과를 확인하지 못했습니다. 요청을 반복하지 말고 목록을 새로 조회해 처리 상태를 확인해 주세요. 계속 확인되지 않으면 서버 기록을 확인한 뒤 다시 로그인해 주세요.' : 'Approval or denial result needs checking. Refresh requests to reconcile the state; do not repeat the action. If it remains unresolved, inspect server records before signing in again.',
    initialize, render, multiTarget,
    historyQuery,
    detailRevision: () => detail?.revision(),
    decision: (id, phase) => detail?.decision(id, phase),
    historyLoading: value => { historyBusy=value;el('history')?.setAttribute('aria-busy', String(value));if(value&&historyStatus)historyStatus.textContent=korean?'이력을 조회하는 중입니다.':'Loading history.'; },
    history: data => {
      historyResult=data;historyBusy=false;historyFailure=false;el('history')?.setAttribute('aria-busy','false');
      const incomplete=!!data.coverage?.metadataIncomplete;
      if(historyStatus)historyStatus.textContent=incomplete ? (korean?`확인 가능한 기록 ${formatNumber(data.items.length)}건을 표시합니다. 일부 기록이 제외된 불완전 조회이며, 0건이어도 기록이 없다고 판단할 수 없습니다.`:`Showing verifiable requests: ${formatNumber(data.items.length)}. Results are incomplete because some records were excluded; zero results do not establish that no history exists.`) : (korean?`${formatNumber(data.items.length)}건을 표시합니다. 전체 건수는 제공하지 않습니다.`:`Showing requests: ${formatNumber(data.items.length)}. An all-time total is not available.`);
      if(historyCoverage){
        historyCoverage.dataset.incomplete=String(incomplete);
        const warning=incomplete ? (korean?'일부 기록 제외: 기록 정보나 현재 연결을 확인하지 못한 기록은 표시하지 않습니다. 아래 목록은 조회 범위의 모든 기록을 보장하지 않습니다. ':'Some records excluded: metadata or the current connection could not be verified. The list does not represent complete history for the selected scope. ') : '';
        historyCoverage.textContent=data.coverage ? warning+(korean?`조회 가능한 보관 기록 · 명령 저장기록 ${data.coverage.commandJournal?'포함':'없음'} · CLI 저장기록 ${data.coverage.cliJournal?'포함':'없음'} · 파일 이력은 현재 메모리에만 보관됩니다. 삭제·미등록 서버는 제외하며 CLI는 현재 연결 설정의 기록만 표시합니다. 조회 중 새 기록이 반영될 수 있습니다.`:`Retained history · Command journal ${data.coverage.commandJournal?'included':'unavailable'} · CLI journal ${data.coverage.cliJournal?'included':'unavailable'} · File history is memory-only. Unregistered targets are excluded; CLI history covers current bindings only. Records may change during browsing.`) : '';
      }
      render(latestJobs,latestDeciding);
    },
    historyError: message => { historyResult={items:[],nextCursor:null};historyBusy=false;historyFailure=true;el('history')?.setAttribute('aria-busy','false');if(historyStatus)historyStatus.textContent=message;render(latestJobs,latestDeciding); },
    target: () => el('target-filter')?.value || undefined,
    selectionRevision: () => selectionRevision,
    targets(data, changed) {
      targetList = data.targets;
      const select = el('target-filter'); select.replaceChildren();
      const all = text(select, 'option', t('전체 대상')); all.value = '';
      for (const target of data.targets) { const option = text(select, 'option', `${target.displayName} (${target.id})${target.platform ? ' · ' + (target.platform === 'windows' ? 'Windows' : 'Linux') : ''}${target.enabled ? '' : ` · ${t('사용 중지')}`}`); option.value = target.id; }
      select.ariaLabel = korean ? '요청 조회 대상' : 'Request query target'; el('target-filter-label').hidden = false;
      identify(); changeTarget = select.onchange = () => {
        scrolls.set(lastTarget, ['jobs','running','history'].map(id => el(id)?.scrollTop ?? 0)); lastTarget = select.value;
        selectionRevision++; detail?.close(false); if(returnButton)returnButton.hidden=true; historyOffset = 0; historyAnchor = undefined; historyResult=undefined;historyCursor=undefined;historyPrevious=[];render(latestJobs, latestDeciding); identify();
        ['jobs','running','history'].forEach((id,i) => { if (el(id)) el(id).scrollTop = scrolls.get(lastTarget)?.[i] ?? 0; });
        document.dispatchEvent?.(new Event('admin-scope-change'));
        el('error').textContent = ''; el('error').hidden = true; changed();
      };
    },
    token: () => el('token').value,
    unauthorized: () => { el('sign-in').hidden = false; },
    error: (message = '') => { el('error').textContent = message; el('error').hidden = !message; },
    loading: busy => { el('load').disabled = false; el('load').setAttribute('aria-busy', String(busy)); },
    deciding: busy => { latestDeciding = busy; detail?.busy(busy); },
    connected: () => {
      el('connection').classList.add('connected'); el('connection-text').textContent = korean ? '관리자 연결됨' : 'Administrator connected'; el('logout').hidden = false; el('sign-in').hidden = true;
      if (el('version-panel')) el('version-panel').hidden = false;
      el('updated').textContent = `${t('마지막 갱신')} ${new Date().toLocaleTimeString(locale)} · ${t('10초마다 갱신')}`;
    },
    versionLoading: busy => {
      const button = el('version-check');
      if (button) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); }
    },
    version: info => {
      const panel = el('version-panel'), status = el('version-status'), link = el('version-link');
      if (!panel || !status || !info) return;
      panel.hidden = false;
      status.dataset.status = info.status ?? 'unavailable';
      const current = info.currentVersion ? `v${info.currentVersion}` : '';
      if (info.status === 'update_available' && info.latestVersion) {
        status.textContent = korean ? `${current} · 새 버전 v${info.latestVersion} 사용 가능` : `${current} · Update v${info.latestVersion} available`;
      } else if (info.status === 'up_to_date') {
        status.textContent = korean ? `${current} · 최신 버전` : `${current} · Up to date`;
      } else if (info.status === 'ahead') {
        status.textContent = korean ? `${current} · 개발/선행 버전` : `${current} · Ahead of release`;
      } else {
        status.textContent = korean ? `${current} · 최신 버전 확인 불가` : `${current} · Update check unavailable`;
      }
      if (link) {
        if (typeof info.releaseUrl === 'string' && info.releaseUrl.startsWith('https://')) link.href = info.releaseUrl;
        link.hidden = info.status !== 'update_available';
      }
    },
    disconnected: () => { el('connection').classList.remove('connected'); el('connection-text').textContent = t('연결 확인 필요'); },
    logoutErrorMessage:()=>korean?'관리자 로그아웃을 확인하지 못했습니다. 다시 시도해 주세요.':'Administrator sign-out could not be confirmed. Please retry.',
    logoutRetry:()=>{el('logout').disabled=false;el('logout').textContent=korean?'로그아웃 다시 시도':'Retry sign out';},
    signedOut: () => {
      detail?.clear();if(returnButton)returnButton.hidden=true;historyResult=undefined;historyCursor=undefined;historyPrevious=[];historyBusy=false;
      if (el('version-panel')) el('version-panel').hidden = true;
      el('token').value = ''; el('jobs').replaceChildren(); el('history').replaceChildren(); records.clear();
      el('running')?.replaceChildren(); el('server-overview')?.replaceChildren(); serverRecords.clear(); targetList = [];
      if (el('overview-section')) el('overview-section').hidden = true;
      if (el('target-filter-label')) el('target-filter-label').hidden = true;
      if (el('running-count')) el('running-count').textContent = '0';
      el('pending-count').textContent = el('history-count').textContent = '0'; el('logout').disabled = el('load').disabled = true;
    },
  };
}
