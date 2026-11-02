import { renderDecision, requestContext } from '../../ui/src/decision.js';

// 목록 갱신은 선택한 요청의 읽기 영역과 부작용의 대상을 바꾸지 않는다.
export function createRequestDetail({ document, i18n, bridgeName, targetName, targets, actions, policy, importNames, announce }) {
  const { t, korean, locale, states, kinds } = i18n;
  const root = document.getElementById('request-detail'), body = document.getElementById('request-detail-body');
  if (!root || !body) return;
  const text = (parent, tag, value = '', className = '') => {
    const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
  };
  const button = (label, run, className = 'secondary') => {
    const node = text(controls, 'button', label, className); node.type = 'button'; node.onclick = run; return node;
  };
  const binding = job => JSON.stringify([job.id, job.targetId, job.targetRevision, job.profile, job.target, job.hostKey]);
  let selected, origin, epoch = 0, busy = false, available = true, actionFocus, outputKey, outputPage, outputBusy = false, sourceBusy = false, decisionKey;
  let previousOffsets = [], outputRead = 0;
  let suspended = false;
  const scrollPositions = new Map();
  const title = text(body, 'h2'); title.id = 'request-detail-title'; title.tabIndex = -1;
  const state = text(body, 'p', '', 'request-detail-state'); state.id = 'request-detail-state';
  const context = text(body, 'p', '', 'target'); context.id = 'request-detail-target';
  const phase = text(body, 'p', '', 'policy-message'); phase.id = 'request-detail-phase';
  const stale = text(body, 'p', '', 'error'); stale.hidden = true;
  const command = text(body, 'pre', '', 'command'); command.tabIndex = 0; command.setAttribute('role', 'region'); command.setAttribute('aria-label', korean ? '요청 내용' : 'Request content');
  const caller = text(body, 'details'); text(caller, 'summary', korean ? '요청자가 제공한 작업 설명' : 'Caller-provided context'); const callerText = text(caller, 'p');
  const sourceMeta = text(body, 'div');
  const decision = text(body, 'div');
  const meta = text(body, 'p', '', 'meta');
  const controls = text(body, 'div', '', 'actions');
  const approve = button(t('승인·실행'), () => decide('approve'), 'primary');
  const deny = button(t('거부'), () => decide('deny'), 'secondary reject');
  const openPolicy = button(korean ? '이 서버 정책 열기' : 'Open this target policy', () => policy(selected.targetId ?? 'default'));
  const register = button(korean ? '이력의 명령 이름 등록' : 'Register names from this command', async () => {
    if (!selected || register.disabled) return;
    const job = selected, revision = epoch; register.disabled = true;
    try { await importNames({ targetId: job.targetId, targetRevision: job.targetRevision, profile: job.profile, command: job.command }); }
    finally { if (revision === epoch) refresh(); }
  });
  const sourceButton = button(korean ? '제출 코드 원문 보기' : 'View submitted source', async () => {
    if (!selected || sourceBusy) return;
    const job = selected, revision = epoch; sourceBusy = true; refresh();
    try {
      const result = await actions.source(job.id);
      if (revision !== epoch || !available || selected?.state !== 'pending') return;
      source.textContent = result.source; source.hidden = false; announce(korean ? '제출 코드 원문을 불러왔습니다.' : 'Submitted source loaded.');
    } catch {
      if (revision === epoch) fail(korean ? '코드 원문을 읽을 수 없습니다. 만료·연결·처리 상태를 확인하세요. 다시 실행하지 않습니다.' : 'Source unavailable. Check expiry, connection and request state; execution is not retried.');
    } finally { if (revision === epoch) { sourceBusy = false; refresh(); } }
  });
  const readOutput = button(korean ? '출력 보기' : 'View output', () => loadOutput(0));
  const saveFile = button(t('파일 저장'), () => actions.download(selected.id));
  for (const node of [approve, deny, openPolicy, register, sourceButton, readOutput, saveFile]) node.setAttribute('aria-describedby', context.id);
  const source = text(body, 'pre', '', 'command submitted-source'); source.tabIndex = 0; source.hidden = true; source.setAttribute('aria-label', korean ? '제출 코드 원문' : 'Submitted source');
  const outputNote = text(body, 'p', '', 'target');
  const outputRange = text(body, 'p', '', 'output-label'); outputRange.id = 'request-output-range';
  const output = text(body, 'pre', '', 'output'); output.id = 'request-output'; output.tabIndex = 0; output.hidden = true; output.setAttribute('role', 'region'); output.setAttribute('aria-label', korean ? '실행 출력' : 'Execution output'); output.setAttribute('aria-describedby', outputRange.id);
  const outputNavigation = text(body, 'div', '', 'actions');
  const previousOutput = text(outputNavigation, 'button', korean ? '이전 부분' : 'Previous page', 'secondary'); previousOutput.type = 'button';
  const nextOutput = text(outputNavigation, 'button', korean ? '다음 부분' : 'Next page', 'secondary'); nextOutput.type = 'button';
  previousOutput.onclick = () => loadOutput(previousOffsets.at(-1) ?? 0, 'previous');
  nextOutput.onclick = () => loadOutput(outputPage?.nextOffset ?? 0, 'next');
  const failure = text(body, 'p', '', 'error'); failure.setAttribute('role', 'alert'); failure.hidden = true;
  root.setAttribute('aria-labelledby', title.id);
  const fail = message => { failure.textContent = message; failure.hidden = !message; };
  function decide(action) {
    if (!selected || !available || busy || !(selected.state === 'pending' || selected.state === 'queued' && action === 'deny')) return;
    return actions.decide(selected.id, action);
  }
  function refresh() {
    if (!selected) return;
    const job = selected, waiting = job.state === 'pending', automated = document.body.dataset.commandAutomation === 'true';
    title.textContent = `${kinds[job.kind] ?? job.kind} · ${job.id}`;
    state.textContent = `${states[job.state] ?? job.state}${job.history?.stateSource === 'journal' ? (korean ? ' · 저장 기록에서 확인' : ' · Recorded history') : ''}`;
    state.dataset.state = job.state;
    if (job.state === 'queued') state.textContent += korean ? ' · 승인이 완료되어 실행 순서를 기다리고 있습니다.' : ' · Approved and waiting for an execution turn.';
    const absent = korean ? '기록 없음' : 'Not recorded';
    context.textContent = `${t('중계기')} · ${bridgeName} / ${t('대상 서버')} · ${job.targetDisplayName ?? targetName}${job.targetId ? ` [${job.targetId}]` : ''} (${job.target ?? absent}) · ${t('요청')} ${job.id}`;
    if (job.targetId) context.textContent += ` · ${t('설정 revision')} ${job.targetRevision ?? absent} / ${t('호스트 키')} ${job.hostKey ?? absent}`;
    const currentBinding = !job.history || job.history.targetStatus === 'active';
    if (job.history?.targetStatus && !currentBinding) context.textContent += korean ? (job.history.targetStatus === 'disabled' ? ' · 현재 대상 사용 중지' : ' · 현재 대상 설정이 기록 당시와 다름') : (job.history.targetStatus === 'disabled' ? ' · Target currently disabled' : ' · Current target binding differs from this record');
    const content = job.kind === 'command' ? job.command : JSON.stringify(job.operation, null, 2);
    if (command.textContent !== content) command.textContent = content;
    callerText.textContent = requestContext(job, korean) ?? ''; caller.hidden = !callerText.textContent;
    const time = waiting ? job.expiresAt : job.finishedAt ?? job.createdAt;
    meta.textContent = `${t(waiting ? '만료' : job.finishedAt ? '처리 완료' : '요청')} ${new Date(time).toLocaleString(locale)}`;
    if (job.operation?.sourceContract) {
      const op = job.operation;
      sourceMeta.textContent = `Python · ${op.sourceContract} · ${op.sourceBytes} bytes · SHA-256 ${op.sourceSha256}\n${JSON.stringify({ cwd: op.sourceCwd, argv: JSON.parse(op.sourceArgvJson), elevate: op.sourceElevate })}`;
      if (targets().find(target => target.id === job.targetId)?.platform === 'windows') sourceMeta.textContent += korean ? '\nWindows의 관리자 등록 Python 경로와 격리 시작 옵션을 사용합니다. 권한 상승에는 기존 관리자 연결 토큰이 필요합니다.' : '\nUses the registered Windows Python path with isolated startup flags. Elevation requires the existing administrator connection token.';
      if (job.state === 'queued') sourceMeta.textContent += korean ? '\n승인된 코드 원문은 이 화면에서 표시하지 않습니다. 실행 계획 정보만 표시합니다.' : '\nApproved source is not displayed here. Only execution plan metadata is shown.';
      else if (!waiting) sourceMeta.textContent += korean ? '\n처리된 코드 원문은 보관하지 않습니다. 실행 계획 정보만 표시합니다.' : '\nFinished source is not retained. Only execution plan metadata is shown.';
    } else sourceMeta.textContent = '';
    const nextDecision = JSON.stringify([job.decision, job.state, job.approvalMode]);
    if (nextDecision !== decisionKey) { decision.replaceChildren(); if (job.decision) renderDecision(document, decision, job.decision, korean, job); decisionKey = nextDecision; }
    const focusedAction = [approve, deny].includes(document.activeElement);
    approve.hidden = !waiting;
    deny.hidden = !waiting && job.state !== 'queued';
    deny.textContent = job.state === 'queued' ? (korean ? '실행 취소' : 'Cancel execution') : t('거부');
    approve.disabled = deny.disabled = busy || !available;
    openPolicy.hidden = !automated; openPolicy.disabled = !available;
    register.hidden = !automated || job.kind !== 'command' || !!job.operation?.sourceContract || ['pending', 'queued', 'running', 'evaluating'].includes(job.state) || targets().find(target => target.id === (job.targetId ?? 'default'))?.capabilities?.commandNameApproval === false;
    register.disabled = !available || !currentBinding || ![job.targetId, job.targetRevision, job.profile, job.command].every(value => typeof value === 'string' && value.length);
    sourceButton.hidden = !waiting || !job.operation?.sourceContract; sourceButton.disabled = sourceBusy || !available;
    if (!waiting) { source.hidden = true; source.textContent = ''; }
    saveFile.hidden = job.kind !== 'download' || job.state !== 'completed'; saveFile.disabled = !available;
    const stored = job.kind === 'command' && job.result?.structuredContent?.output;
    readOutput.hidden = !stored; readOutput.disabled = !available || !currentBinding || stored?.state !== 'ready' || outputBusy;
    outputNote.textContent = stored ? (korean ? `저장된 실행 결과 · ${stored.bytes ?? 0}바이트 · ${stored.state}. 저장 상태와 읽기 권한은 다릅니다. 열 때 대상 활성화·설정·만료를 다시 확인합니다. 전체 SSH 출력의 완전성은 확인되지 않았습니다.` : `Stored result · ${stored.bytes ?? 0} bytes · ${stored.state}. Storage is separate from read access; opening rechecks target, revision and expiry. Complete SSH capture is not guaranteed.`) : job.kind === 'download' && job.state === 'completed' ? (korean ? '서버 파일 준비 완료. PC 저장이나 에이전트 수신은 아직 확인되지 않았습니다.' : 'Server file ready. Device save or agent receipt is not confirmed.') : '';
    if (stored?.id !== outputKey) {
      outputRead++; outputKey = stored?.id; outputPage = undefined; outputBusy = false; previousOffsets = []; output.textContent = ''; output.hidden = true; outputRange.textContent = '';
    }
    if (!stored && job.result) {
      const blocks = job.result.content?.filter(item => item.type === 'text');
      const value = blocks?.length ? blocks.map(item => item.text ?? '').join('\n') : JSON.stringify(job.result.structuredContent ?? job.result, null, 2);
      if (output.textContent !== value) output.textContent = value;
      output.hidden = false; outputRange.textContent = t('실행 결과');
    }
    outputNavigation.hidden = !outputPage;
    previousOutput.disabled = outputBusy || !previousOffsets.length || !available || !currentBinding;
    nextOutput.disabled = outputBusy || !outputPage || outputPage.eof || !available || !currentBinding;
    if (job.auditError) fail(job.auditError);
    if (!root.hidden && !waiting && (focusedAction || actionFocus && document.activeElement === document.body)) { title.focus(); actionFocus = undefined; }
  }
  async function loadOutput(offset, direction = 'first') {
    if (!selected || !available || outputBusy || !outputKey) return;
    const revision = epoch, read = ++outputRead, key = outputKey, oldOffset = outputPage?.offsetBytes;
    const trigger = document.activeElement, reading = [readOutput, previousOutput, nextOutput].includes(trigger);
    outputBusy = true; fail(''); refresh();
    try {
      const page = await actions.output(key, offset);
      if (revision !== epoch || read !== outputRead || key !== outputKey || !available || selected?.history && selected.history.targetStatus !== 'active') return;
      if (direction === 'next' && oldOffset !== undefined) previousOffsets.push(oldOffset);
      else if (direction === 'previous') previousOffsets.pop();
      else previousOffsets = [];
      outputPage = page; output.textContent = page.text; output.hidden = false; output.scrollTop = 0;
      outputRange.textContent = `${page.offsetBytes}–${page.nextOffset} / ${page.totalBytes} bytes`;
      announce(korean ? `실행 출력 ${page.offsetBytes}–${page.nextOffset}바이트를 불러왔습니다.` : `Execution output ${page.offsetBytes}–${page.nextOffset} bytes loaded.`);
      if (reading && [trigger, document.body].includes(document.activeElement)) output.focus();
    } catch {
      if (revision === epoch && read === outputRead) fail(korean ? '출력을 읽을 수 없습니다. 만료·연결·대상 상태를 확인하세요. 명령은 다시 실행하지 않습니다.' : 'Output unavailable. Check expiry, connection and target state; the command is not rerun.');
    } finally { if (revision === epoch && read === outputRead) { outputBusy = false; refresh(); } }
  }
  function close(restore = true) {
    origin?.setAttribute('aria-expanded', 'false'); origin?.closest('[data-request-id]')?.classList.remove('is-selected');
    epoch++; outputRead++; selected = undefined; actionFocus = undefined; suspended = false; scrollPositions.clear(); root.hidden = true; body.dataset.requestId = ''; output.textContent = source.textContent = ''; output.hidden = source.hidden = true;
    if (restore) {
      const selector = origin?.isConnected && origin.getClientRects().length ? origin : document.getElementById(document.body.dataset.page === 'history' ? 'history' : 'jobs');
      selector?.focus();
    }
    origin = undefined;
  }
  document.getElementById('request-close')?.addEventListener('click', () => close());
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  function rememberScroll() {
    if (!root.hidden && root.getClientRects().length) for (const node of [root, command, source, output]) scrollPositions.set(node, node.scrollTop);
  }
  for (const node of [root, command, source, output]) node.addEventListener('scroll', rememberScroll, { passive: true });
  document.addEventListener('admin-before-scope-change', rememberScroll);
  return {
    select(job, opener) {
      if (!selected || selected.id !== job.id || binding(selected) !== binding(job)) {
        epoch++; outputRead++; selected = job; actionFocus = undefined; suspended = false; scrollPositions.clear(); outputKey = undefined; outputPage = undefined; outputBusy = sourceBusy = false; previousOffsets = []; decisionKey = undefined; output.textContent = source.textContent = outputRange.textContent = ''; output.hidden = source.hidden = true; caller.open = false; phase.textContent = ''; fail('');
      }
      origin?.setAttribute('aria-expanded', 'false'); origin?.closest('[data-request-id]')?.classList.remove('is-selected');
      origin = opener; origin?.setAttribute('aria-expanded','true'); origin?.closest('[data-request-id]')?.classList.add('is-selected'); available = true; stale.hidden = true; root.hidden = false; body.dataset.requestId = job.id; refresh(); title.focus();
    },
    update(jobs, deciding) {
      busy = deciding;
      if (!selected) return;
      const latest = jobs.find(job => job.id === selected.id), priorState = selected.state;
      // 페이지 밖의 종료된 저장 기록은 읽던 상세를 유지하되, 읽기 권한은 API가 다시 확인한다.
      available = latest ? binding(latest) === binding(selected) : !!selected.history && !['pending', 'queued', 'running', 'evaluating'].includes(selected.state);
      if (latest && available) selected = latest;
      stale.hidden = available;
      stale.textContent = korean ? '현재 조회에서 같은 대상의 요청을 확인하지 못했습니다. 기존 상세는 읽을 수 있지만 실행·결과 읽기는 중단합니다. 목록을 새로 조회하세요.' : 'This request binding is absent from the current snapshot. The existing detail remains readable; actions are blocked. Refresh requests.';
      refresh();
      if (available && priorState !== selected.state) {
        phase.textContent = '';
        announce(`${selected.targetDisplayName ?? targetName} · ${selected.id} · ${states[selected.state] ?? selected.state}`);
      }
    },
    busy(value) { busy = value; if ([approve, deny].includes(document.activeElement)) actionFocus = document.activeElement; refresh(); },
    decision(id, value) {
      if (selected?.id !== id) return;
      phase.textContent = value === 'sending' ? (korean ? '승인·거부 요청을 보내는 중입니다.' : 'Sending decision.') : value === 'accepted' ? (korean ? '승인·거부가 접수되었습니다. 실행 완료 여부는 현재 상태로 확인하세요.' : 'Decision accepted. Check the state for execution completion.') : (korean ? '처리 결과를 확인하지 못했습니다. 요청을 반복하지 말고 목록을 새로 조회하세요.' : 'Decision result is uncertain. Refresh requests without repeating the action.');
      announce(phase.textContent);
    },
    page(active) {
      if (!selected) return;
      if (!active && !suspended) {
        rememberScroll(); epoch++; outputRead++; outputBusy = sourceBusy = false; actionFocus = undefined; suspended = true; root.hidden = true;
      } else if (active && suspended) {
        suspended = false; root.hidden = false; refresh();
        for (const [node, top] of scrollPositions) node.scrollTop = top;
      }
    },
    selected: () => !!selected,
    close, clear: () => { close(false); for (const node of [title, state, context, phase, command, callerText, sourceMeta, decision, meta, outputNote, outputRange, failure, stale]) node.textContent = ''; }, revision: () => epoch,
  };
}
