import { renderDecision } from './decision.js';
export function createCardView({ document, i18n }) {
  const { t, korean, locale, states } = i18n;
  const el = id => document.getElementById(id);
  let buttons = [];
  function text(parent, tag, value, className = '') {
    const node = document.createElement(tag); node.textContent = value; node.className = className; parent.append(node); return node;
  }
  function button(title, action, disabled = false) {
    const node = text(el('controls'), 'button', title); node.disabled = disabled;
    node.onclick = event => { if (event.isTrusted && !node.disabled) return action(); };
    buttons.push({ node, disabled }); return node;
  }
  function clear() { buttons = []; el('details').replaceChildren(); el('controls').replaceChildren(); }
  function status(message, state) {
    if (state) el('status').dataset.state = state; else delete el('status').dataset.state;
    el('status').textContent = message;
  }
  function identity(meta) {
    const names = [meta.bridgeDisplayName, meta.targetDisplayName].filter(Boolean);
    document.title = [...names, korean ? 'SSH 승인 및 파일 전송' : 'SSH approval and file transfer'].join(' · ');
    if (meta.bridgeDisplayName) text(el('details'), 'p', `${t('중계기')} · ${meta.bridgeDisplayName}`, 'server-identity');
    if (meta.targetDisplayName) text(el('details'), 'p', `${t('대상 서버')} · ${meta.targetDisplayName}`, 'server-identity');
  }
  function job(job, meta, actions) {
    clear(); identity(meta); status(states[job.state] ?? job.state, job.state);
    if (job.approvalMode === 'automatic') text(el('details'), 'p', korean ? '자동승인' : 'Automatically approved', 'badge automatic-approval');
    const infoBox = text(el('details'), 'div', '', 'request-meta');
    text(infoBox, 'p', `${t('대상 서버')} · ${job.target}`);
    const info = text(infoBox, 'details', ''); text(info, 'summary', t('요청 정보'));
    text(info, 'p', `${t('요청')} ${job.id}`, 'request-id');
    if (job.targetId) {
      text(info, 'p', `${t('대상 ID')} · ${job.targetId}`);
      text(info, 'p', `${t('설정 revision')} · ${job.targetRevision}`);
      text(info, 'p', `${t('호스트 키')} · ${job.hostKey}`);
    }
    text(info, 'p', `${t('승인 만료')} ${new Date(job.expiresAt).toLocaleString(locale)}`);
    text(el('details'), 'p', t(job.kind === 'command' ? '실행할 명령' : '파일 전송 내용'), 'section-label');
    if (job.kind === 'command') text(el('details'), 'pre', job.command);
    else {
      const op = job.operation, result = job.result?.structuredContent;
      const list = text(el('details'), 'dl', '', 'operation-fields');
      for (const [label, value] of [
        ['방향', t(job.kind === 'upload' ? 'PC → 서버' : '서버 → PC')],
        ['파일명', op.fileName ?? result?.fileName ?? op.remotePath.split('/').pop()],
        ['서버 경로', op.remotePath], ['크기', op.size ?? result?.size], ['SHA-256', op.sha256 ?? result?.sha256],
        ['sudo 사용', t(op.elevate ? '예' : '아니요')], ...(job.kind === 'upload' ? [['덮어쓰기', t(op.overwrite ? '예' : '아니요')]] : []),
      ]) {
        if (value === undefined) continue;
        text(list, 'dt', t(label));
        text(list, 'dd', label === '크기' ? `${value.toLocaleString(locale)} ${t('바이트')}` : value, label === 'SHA-256' ? 'hash' : '');
      }
    }
    if (job.kind === 'command' && job.operation?.context) { const context = text(el('details'), 'details', ''); text(context, 'summary', korean ? '요청자가 제공한 작업 설명' : 'Caller-provided context'); text(context, 'p', job.operation.context); }
    if (job.decision) renderDecision(document, el('details'), job.decision, korean);
    const output = job.result?.structuredContent?.output;
    if (output && job.kind === 'command') {
      text(el('details'), 'p', korean ? `저장된 실행 결과 · ${output.bytes ?? 0}바이트 · ${output.state}` : `Stored result · ${output.bytes ?? 0} bytes · ${output.state}`);
      text(el('details'), 'p', korean ? '필요할 때만 내용을 읽습니다. SSH 전체 출력의 완전성은 확인되지 않았습니다.' : 'Load content only when needed. Complete SSH capture is not guaranteed.');
      if (output.state === 'ready') button(korean ? '출력 보기' : 'View output', actions.output, !meta.uiEnabled || !meta.viewTicket);
      const area = text(el('details'), 'div', ''); area.id = 'command-output';
    } else if (job.result && job.kind === 'command') {
      text(el('details'), 'p', t('실행 결과'), 'section-label');
      text(el('details'), 'pre', job.result.content?.map(x => x.text ?? '').join('\n') || JSON.stringify(job.result.structuredContent ?? job.result));
    }
    if (job.result?.isError && job.kind !== 'command') text(el('details'), 'pre', job.result.content?.map(x => x.text ?? '').join('\n') ?? t('파일 전송에 실패했습니다.'));
    if (job.auditError) text(el('details'), 'p', job.auditError);
    if (job.state === 'pending') for (const action of ['approve', 'deny']) button(t(action === 'approve' ? '승인·실행' : '거부'), () => actions.decide(action), !meta.uiEnabled || !meta.approvalTicket);
    if (job.kind === 'download' && job.state === 'completed') button(t('파일 저장'), actions.save, !meta.uiEnabled || !meta.viewTicket);
  }
  function transfer(seed, meta, submit, selectTarget) {
    clear(); identity(meta); status(t(seed.direction === 'upload' ? '파일 업로드 준비' : '파일 다운로드 준비'));
    if (seed.target && meta.targets) {
      const label = text(el('details'), 'label', t('대상 서버'));
      const select = document.createElement('select'); select.ariaLabel = t('대상 서버');
      for (const target of meta.targets) { const option = text(select, 'option', `${target.displayName} (${target.id})`); option.value = target.id; option.disabled = !target.enabled; }
      select.value = seed.target; select.onchange = () => selectTarget(select.value); label.append(select);
    }
    const label = text(el('details'), 'label', t('서버의 절대 파일 경로'));
    const path = document.createElement('input'); path.type = 'text'; path.value = seed.remotePath; label.append(path);
    const elevated = document.createElement('input'); elevated.type = 'checkbox'; elevated.checked = seed.elevate;
    const elevationLabel = text(el('details'), 'label', t(' sudo로 전송')); elevationLabel.prepend(elevated);
    let overwrite, fileInput;
    if (seed.direction === 'upload') {
      fileInput = document.createElement('input'); fileInput.type = 'file'; el('details').append(fileInput);
      overwrite = document.createElement('input'); overwrite.type = 'checkbox'; overwrite.checked = seed.overwrite;
      const replacement = text(el('details'), 'label', t(' 기존 파일 덮어쓰기')); replacement.prepend(overwrite);
      text(el('details'), 'p', `${t('최대')} ${Math.floor(meta.maxBytes / 1024 / 1024)} MiB. ` + (korean ? '서버 정책에서 허용한 새 파일은 자동 전송될 수 있습니다. 그 밖의 전송은 승인이 필요합니다.' : 'Owner policy may allow automatic uploads of new files; other transfers require approval.'));
    }
    // The visible input owns its file; a replacement view never inherits it.
    button(seed.direction === 'upload' ? (korean ? '파일 업로드 요청' : 'Request file upload') : t('다운로드 요청'), () => submit({
      ...(seed.target === undefined ? {} : { target: seed.target }), direction: seed.direction, remotePath: path.value, elevate: elevated.checked, overwrite: overwrite?.checked ?? false,
    }, fileInput?.files?.[0] ?? null), !meta.uiEnabled);
    if (!meta.uiEnabled) text(el('details'), 'p', t('UI 동작은 클라이언트 검증 후 활성화됩니다.'));
  }
  function initialize(openWeb) {
    document.documentElement.lang = korean ? 'ko' : 'en';
    document.title = korean ? 'SSH 승인 및 파일 전송' : 'SSH approval and file transfer';
    el('details').ariaLabel = korean ? '요청 내용' : 'Request details';
    if (!korean) for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    el('web').onclick = event => { if (event.isTrusted) return openWeb(); };
  }
  function theme(context) {
    if (!context?.theme) return;
    document.documentElement.style.colorScheme = context.theme; document.documentElement.dataset.theme = context.theme;
  }
  return {
    t, initialize, job, transfer, theme, clear,
    output(value, page, next) {
      const area = el('command-output'); if (!area) return; area.replaceChildren();
      text(area, 'p', `${page.offsetBytes}–${page.nextOffset} / ${page.totalBytes} bytes`);
      text(area, 'pre', value);
      if (next) { const node = text(area, 'button', korean ? '다음 부분' : 'Next page'); node.onclick = event => { if (event.isTrusted) return next(); }; }
    },
    error: message => { el('error').textContent = message; },
    setBusy: busy => { for (const { node, disabled } of buttons) node.disabled = busy || disabled; },
    probe: (marker, meta = {}) => { clear(); identity(meta); status(t('표시 시험 — 명령은 실행되지 않습니다')); text(el('details'), 'pre', marker ?? t('UI 전용 메타데이터를 받지 못했습니다')); },
    missing: () => { status(t('요청을 찾을 수 없습니다. 재시작으로 유실됐을 수 있습니다.')); buttons = []; el('controls').replaceChildren(); },
    progress: percent => { el('status').textContent = `${t('중계기 전송')} ${percent}%`; },
  };
}
