import commandRisks from '../../src/domain/command-risks.json' with { type: 'json' };
const RECOMMENDED = Object.fromEntries(commandRisks.defaultCommands.map(name => [name, commandRisks.commands[name].description]));
const CATALOG = Object.entries(commandRisks.commands).map(([name, value]) => [name, value.description, value.category]);
const riskLabel = level => ({ low: '낮음', moderate: '보통', high: '높음', unknown: '정보 없음' }[level] ?? '정보 없음');
const nameSummary = names => names.slice(0, 8).join(', ') + (names.length > 8 ? ' 외 ' + (names.length - 8) + '개' : '');
const linesOf = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const same = (a, b) => JSON.stringify(a ?? null, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(b ?? null, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const CURRENT = 'ssh-command-risk-v4', BASIS = 'safety-probability-v1';
const legacy = threshold => threshold && (threshold.questionVersion !== CURRENT || threshold.basis !== BASIS);

/** Preserve the owner policy; only explicitly edited settings become a proposal. */
export function createCommandPolicyEditor({ document, api, onNavigate = () => {} }) {
  if (document.body.dataset.commandAutomation !== 'true') return;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('details', '', 'request policy-editor'); root.id = 'command-policy';
  root.append(el('summary', '자동승인 설정'), el('p', '명령을 검색해 고르고, 허용 범위와 변경 내용을 확인한 뒤 저장하세요. 처음 제공되는 목록은 아직 적용되지 않은 초안입니다.', 'policy-intro'));
  const reload = el('button', '다시 불러오기', 'secondary'); reload.type = 'button'; reload.setAttribute('aria-label', '서버 설정 다시 불러오기');
  const message = el('p', '', 'policy-message'); message.setAttribute('role', 'status');
  const toolbar = el('div', '', 'policy-toolbar'); toolbar.append(message, reload); root.append(toolbar);
  const loadHint = el('p', '초안은 이 페이지의 메모리에만 보관됩니다. 페이지를 닫거나 새로고침하면 사라집니다.', 'policy-help'); loadHint.hidden = true; root.append(loadHint);
  const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert'); failure.hidden = true; root.append(failure);
  const reconcile = el('button', '현재 적용 설정 확인', 'secondary'); reconcile.type = 'button'; reconcile.hidden = true; root.append(reconcile);
  const conflictBox = el('section', '', 'policy-warning'); conflictBox.hidden = true; root.append(conflictBox);
  const conflictText = el('p'); conflictText.setAttribute('role', 'status'); conflictBox.append(conflictText);
  const preserved = el('details', '', 'policy-details'); preserved.append(el('summary', '보존한 초안 보기 · 복사 가능'));
  const preservedText = el('pre'); preserved.append(preservedText); conflictBox.append(preserved);
  const latest = el('button', '최신 설정으로 새 초안 시작', 'secondary'); latest.type = 'button'; conflictBox.append(latest);
  const form = el('form'); form.className = 'policy-form';
  const important = el('section', '', 'request policy-editor important-settings'); important.id = 'important-settings';
  important.append(el('h2', '중요 자동승인 설정'), el('p', '파일 업로드·다운로드·sudo와 AI 평가를 통한 자동승인 허용 여부를 서버별로 설정합니다. 변경 후 위험도 확인·OK·저장을 거쳐야 적용됩니다.', 'policy-help'));
  const importantFields = el('fieldset', '', 'policy-fields'); importantFields.disabled = true; important.append(importantFields);
  const importantStatus = el('p', '서버 설정을 불러오면 현재 허용 상태를 표시합니다.', 'policy-message'); importantStatus.setAttribute('role','status'); important.append(importantStatus);
  const activity = el('p', '', 'policy-help'); activity.id = 'policy-activity'; activity.setAttribute('role', 'status'); activity.setAttribute('aria-atomic', 'true'); important.append(activity);
  const quickLoad = el('button', '현재 설정 불러오기', 'secondary'); quickLoad.type = 'button'; important.append(quickLoad);
  form.append(important, root);
  const fields = el('fieldset', '', 'policy-fields'); fields.hidden = true; root.append(fields);
  const section = (number, title) => {
    const node = el('section', '', 'policy-section'); node.append(el('h3', number + '. ' + title)); fields.append(node); return node;
  };
  let fieldId = 0;
  const fieldErrors = new Map();
  const field = (parent, label, tag = 'input', type = 'text', hint = '') => {
    const box = el('label', '', 'policy-field'), input = el(tag);
    const caption = el('span', label); caption.id = 'policy-label-' + ++fieldId;
    input.setAttribute('aria-labelledby', caption.id); box.append(caption); if (tag === 'input') input.type = type;
    box.append(input); parent.append(box);
    if (hint) { const help = el('p', hint, 'policy-help'); help.id = 'policy-help-' + fieldId; input.setAttribute('aria-describedby', help.id); parent.append(help); }
    const error = el('p', '', 'policy-field-error'); error.id = 'policy-error-' + fieldId; error.hidden = true; error.setAttribute('role', 'alert'); parent.append(error); fieldErrors.set(input, error);
    return input;
  };
  const check = (parent, title, explanation) => {
    const label = el('label', '', 'policy-check'), input = el('input'); input.type = 'checkbox';
    const text = el('span'); text.append(el('strong', title), el('small', explanation)); label.append(input, text); parent.append(label); return input;
  };
  const one = section(1, '명령 고르기');
  const target = field(importantFields, '설정할 서버', 'select');
  const search = field(one, '명령 검색', 'input', 'search', '내장 Linux 명령 ' + CATALOG.length + '개를 이름·기능으로 찾습니다. 서버에 설치됐는지는 확인하지 않으며 검색으로 명령을 실행하지 않습니다.');
  search.placeholder = '예: grep, 파일 찾기, 프로세스'; search.autocomplete = 'off'; search.maxLength = 100;
  const searchStatus = el('p', '', 'policy-help'); searchStatus.setAttribute('role', 'status'); one.append(searchStatus);
  const searchResults = el('div', '', 'policy-search-results'); searchResults.setAttribute('role', 'group'); searchResults.setAttribute('aria-label', '명령 검색 결과'); searchResults.hidden = true; one.append(searchResults);
  const commands = field(one, '자동승인할 명령', 'textarea', '', '이름만 한 줄에 하나. 예: ls (-l 같은 옵션은 빼주세요.)'); commands.rows = 5; commands.spellcheck = false;
  const count = el('p', '', 'policy-help'); one.append(count);
  const capability = el('p', '', 'policy-warning'); one.append(capability);
  const selectedDetails = el('details', '', 'policy-details'); selectedDetails.append(el('summary', '선택 명령 확인 · 기능과 위험 안내'));
  const selectedFilter = field(selectedDetails, '선택 명령 필터', 'input', 'search'); selectedFilter.placeholder = '선택한 이름에서 찾기';
  const selectedStatus = el('p', '', 'policy-help'); selectedStatus.setAttribute('role', 'status'); selectedDetails.append(selectedStatus);
  const selectedList = el('ul', '', 'policy-selected-list'); selectedDetails.append(selectedList); one.append(selectedDetails);
  one.append(el('p', '이름을 승인하면 옵션·인자와 출력 리다이렉션의 영향도 함께 허용합니다. 목록에서 제외하는 것은 금지가 아닙니다. 금지 목록은 항상 우선하고 sudo는 위의 별도 허용이 필요합니다.', 'policy-help'));
  const examples = el('details', '', 'policy-details'); examples.append(el('summary', '언제 자동승인되나요?'));
  for (const text of ['ls와 pwd를 등록했다면: pwd && ls -la → Jev 없이 자동승인', 'uptime이 미등록이라면: pwd && uptime → 전체 명령줄을 Jev로 평가', '명령 이름이 동적이거나 구조를 읽을 수 없다면 → 전체 평가 경로', '금지 명령이 포함되면 자동승인보다 금지가 우선합니다.', 'sudo가 꺼져 있으면 sudo 요청은 개별 승인합니다. 켜도 내부 명령 등록 여부를 확인합니다.']) examples.append(el('p', text, 'policy-help'));
  one.append(examples);
  one.append(el('p', '명령줄의 명령이 모두 사전승인 목록에 있으면 인자 위험도·Jev 평가 없이 실행합니다. 하나라도 미등록이거나 구조를 읽을 수 없으면 전체 명령줄을 평가 경로로 보냅니다.', 'policy-help'));
  const uploads = check(importantFields, '파일 자동업로드 허용', '폴더 제한 없이 SSH 계정이 쓸 수 있는 경로에 새 파일을 개별 승인 없이 저장합니다. 설정·인증·자동 실행 파일 생성에도 영향을 줍니다. 덮어쓰기·sudo 전송은 계속 승인받으며 파일 내용은 Jev가 검사하지 않습니다.');
  const downloads = check(importantFields, '파일 자동다운로드 허용', 'SSH 계정이 읽을 수 있는 일반 파일을 개별 승인 없이 준비합니다. 개인정보·인증 파일도 포함될 수 있으며 파일 내용은 Jev가 검사하지 않습니다. sudo 다운로드는 sudo 자동승인도 함께 켜야 합니다. 파일 저장은 별도로 진행합니다.');

  const sudo = check(importantFields, 'sudo 자동승인 허용', '기본값은 꺼짐입니다. 켜면 sudo 안에서 실행하는 명령까지 사전승인 목록과 비교합니다. 하나라도 미등록이면 전체 명령줄을 Jev로 평가하며, 끄면 sudo는 매번 개별 승인을 받습니다.');

  const execution = check(importantFields, 'Jev·다른 모델을 통한 자동승인 허용', '미등록 명령이 있으면 전체 명령줄을 평가해 저장한 기준을 충족할 때 자동 실행합니다. 정보 전송 허용과 연결된 평가 모델도 필요합니다. 끄면 미등록 명령은 개별 승인하고 사전승인 명령은 계속 자동 실행합니다.');

  const two = section(2, 'Jev 도움받기');
  const jevModel = field(two, 'Jev 모델', 'select', '', '선택한 모델로 실제 평가합니다. 바꾼 뒤 위험도 확인과 저장이 필요합니다.');
  const modelNote = el('p', '', 'policy-help'); two.append(modelNote);
  const disclosure = check(two, 'Jev에 정보 전송 허용', '명령·작업 상황·서버 정보를 TypeSafe의 Jev로 보냅니다. 저장 전 위험도 확인부터 전송됩니다.');
  const disclosureDetails = el('details', '', 'policy-details'); disclosureDetails.append(el('summary', '전송 정보 자세히 보기'), el('p', '등록 전에는 후보 명령셋·대상·프로필 정보를 보냅니다. 실행 판단에는 전체 명령, 작업 상황, 대상·프로필·접속대상, 명령셋과 사용자 명시적 승인 여부를 보냅니다.', 'policy-help')); two.append(disclosureDetails);
  const transmissionNote = el('p', '', 'policy-warning'); two.append(transmissionNote);
  const scoreBox = el('div'); two.append(scoreBox);
  const probability = field(scoreBox, 'Jev 자동승인 기준 (%)', 'input', 'number', '예: 90을 입력하면 90%입니다. 모델의 낮은 위험 점수 기준이며 실제 안전을 보증하지 않습니다.');
  probability.min = '50'; probability.max = '100'; probability.step = 'any';
  const legacyBox = el('div', '', 'policy-warning'); scoreBox.append(legacyBox);

  const advanced = el('details', '', 'policy-details policy-advanced'), advancedHeading = el('summary', '고급 설정'); advanced.append(advancedHeading); fields.append(advanced);
  const advancedNote = el('p', '', 'policy-help'); advanced.append(advancedNote);
  const denied = field(advanced, '항상 차단할 명령', 'textarea', '', '금지 목록은 자동승인보다 우선합니다. 비워두면 별도로 지정하지 않습니다.'); denied.rows = 3;
  const fallback = field(advanced, 'Jev 평가 불가 시 대체 평가자', 'select');
  for (const [value, label] of [['', '사용 안 함'], ['luna', 'Luna · 서버 연결 별도 필요'], ['sonnet', 'Sonnet · 서버 연결 별도 필요']]) { const option = el('option', label); option.value = value; fallback.append(option); }
  advanced.append(el('p', '이 화면은 평가자의 연결 상태를 확인하지 않습니다. 평가할 수 없거나 판단이 불충분하면 사용자 승인으로 넘어갑니다.', 'policy-help'));
  const scores = {};
  for (const provider of ['jev', 'luna', 'sonnet']) {
    const box = el('div', '', 'policy-provider'); advanced.append(box);
    const model = provider === 'jev' ? jevModel : field(box, (provider === 'luna' ? 'Luna' : 'Sonnet') + ' 모델', 'select');
    const score = provider === 'jev' ? probability : field(box, provider + ' 자동승인 기준 (%)', 'input', 'number');
    score.min = '50'; score.max = '100'; score.step = 'any';
    const old = provider === 'jev' ? legacyBox : el('div', '', 'policy-warning'); if (provider !== 'jev') box.append(old);
    const convert = el('button', provider + ' 기준을 현재 방식으로 바꾸기', 'secondary'); convert.type = 'button';
    old.append(el('p', '이전 점수 방식이 저장돼 있습니다. 명령만 바꾸면 그대로 보존합니다. 전환하면 기존 confidence 조건을 없애고 낮은 위험 점수 하나를 쓰며, Jev 자동 실행이 켜져 있다면 실행 가능 범위가 달라질 수 있습니다.'), convert);
    scores[provider] = { box, model, score, old, convert };
  }
  const three = section(3, '위험도 확인 후 저장');
  const summary = el('div', '', 'policy-change-summary'); three.append(summary);
  const reviewButton = el('button', '이 설정으로 위험도 확인', 'primary'); reviewButton.type = 'button'; three.append(reviewButton);
  three.append(el('p', '위험도 확인은 명령을 실행하거나 설정을 저장하지 않습니다.', 'policy-help'));
  const feedback = el('div', '', 'policy-feedback'); feedback.tabIndex = -1; feedback.setAttribute('aria-live', 'polite'); three.append(feedback);
  const confirmation = el('div'); confirmation.hidden = true; three.append(confirmation);
  const acknowledged = check(confirmation, '위험도와 변경 내용을 확인했고 저장에 동의합니다 (OK)', '확인 결과는 5분 동안 유효합니다. 내용을 바꾸면 다시 확인해야 합니다.'); acknowledged.disabled = true;
  const save = el('button', '이 서버에 저장', 'primary'); save.type = 'submit'; save.disabled = true; confirmation.append(save);
  const next = activity; next.textContent = '먼저 위험도를 확인해 주세요.';
  document.querySelector('.grid').before(form);

  let snapshot, original, reviewed, generation = 0, expiry, busy = false, loading = false;
  let currentTarget, conflict = false, unknownSave, searchLimit = 12, selectedLimit = 12;
  const drafts = new Map(), archives = new Map();
  const bindingOf = id => { const b = snapshot?.bindings.find(b => b.targetId === id); return b && { targetId: b.targetId, targetRevision: b.targetRevision, profile: b.profile }; };
  const announce = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const rawInputs = () => [commands, denied, search, selectedFilter, disclosure, execution, uploads, downloads, sudo, fallback, ...Object.values(scores).flatMap(p => [p.model, p.score])];
  function remember() {
    if (!currentTarget || !snapshot || conflict || unknownSave) return;
    drafts.set(currentTarget, { binding: bindingOf(currentTarget), original: structuredClone(original), revision: snapshot.revision,
      values: rawInputs().map(input => input.type === 'checkbox' ? input.checked : input.value), changed: [...changed], converted: [...converted] });
  }
  function preserve(draft) {
    archives.set(target.value, draft); conflictBox.hidden = false;
    preservedText.textContent = ['자동승인 명령:', draft.values[0], '금지 명령:', draft.values[1],
      '정보 전송: ' + draft.values[4] + ' · AI 자동승인: ' + draft.values[5],
      '업로드: ' + draft.values[6] + ' · 다운로드: ' + draft.values[7] + ' · sudo: ' + draft.values[8],
      '대체 평가자: ' + (draft.values[9] || '없음'), ...['jev', 'luna', 'sonnet'].map((p, i) => p + ': ' + draft.values[10 + i * 2] + ' · ' + draft.values[11 + i * 2] + '%')].join('\n');
  }
  function lock() {
    fields.disabled = !snapshot || busy || loading || !!unknownSave || conflict;
    importantFields.disabled = !snapshot || busy || loading || !!unknownSave;
    for (const input of [uploads, downloads, sudo, execution]) input.disabled = conflict;
    reviewButton.disabled = !snapshot || busy || loading || !!unknownSave || conflict;
    reload.disabled = quickLoad.disabled = busy || loading;
    reconcile.disabled = busy || loading; latest.disabled = busy || loading || !!unknownSave;
  }
  const changed = new Set(), converted = new Set();
  const nameOf = id => snapshot?.bindings.find(binding => binding.targetId === id)?.displayName ?? id;
  const error = text => { failure.textContent = text; failure.hidden = !text; };
  const clearFieldErrors = () => { for (const [input, note] of fieldErrors) { note.hidden = true; note.textContent = ''; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-errormessage'); } };
  const invalid = (input, message) => {
    const note = fieldErrors.get(input); note.textContent = message; note.hidden = false;
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-errormessage', note.id); for (let parent = input.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; input.focus();
    const failure = Error(message); failure.field = true; throw failure;
  };
  const invalidate = (text = '내용이 바뀌었습니다. 위험도를 다시 확인해 주세요.') => {
    const active = document.activeElement, restoreFocus = confirmation.contains(active) || feedback.contains(active);
    generation++; clearTimeout(expiry); reviewed = undefined; acknowledged.checked = false; acknowledged.disabled = true; save.disabled = true; confirmation.hidden = true; feedback.replaceChildren(); announce(next, text);
    if (restoreFocus && !reviewButton.disabled) reviewButton.focus();
  };
  function names(input, label) {
    const result = [];
    for (const [index, line] of input.value.split(/\r?\n/).entries()) {
      const name = line.trim(); if (!name) continue;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(name)) invalid(input, label + ' ' + (index + 1) + '번째 줄: 명령 이름만 입력하세요. 예: ls -l 대신 ls');
      if (result.includes(name)) invalid(input, label + ' ' + (index + 1) + '번째 줄: ' + name + '이 중복됐습니다. 한 번만 남겨주세요.');
      result.push(name);
    }
    if (result.length > 128) invalid(input, label + '은 최대 128개까지 등록할 수 있습니다.');
    return result;
  }
  function update() {
    if (snapshot) {
      const dirty = uploads.checked !== (original?.automaticUploads === true) || downloads.checked !== (original?.automaticDownloads === true) || sudo.checked !== (original?.automaticSudo === true) || execution.checked !== (original?.modelExecution === true);
      announce(importantStatus, (unknownSave ? '저장 결과 확인 필요 · 이미 적용됐을 수 있습니다. 현재값을 확인하기 전까지 편집이 잠깁니다. 마지막 확인값: ' : '') + nameOf(target.value) + ' · 저장된 설정: 파일 업로드 ' + (original?.automaticUploads === true ? '허용' : '개별 승인') + ' · 다운로드 ' + (original?.automaticDownloads === true ? '허용' : '개별 승인') + ' · sudo ' + (original?.automaticSudo === true ? '허용' : '개별 승인') + ' · AI 평가 자동승인 ' + (original?.modelExecution === true ? '허용' : '개별 승인') + (!unknownSave && dirty ? ' · 변경 사항은 아직 저장되지 않았습니다.' : ''));
    }
    count.textContent = linesOf(commands.value).length + '개 입력 · 최대 128개';
    const chosen = [...new Set(linesOf(commands.value))], high = chosen.filter(name => commandRisks.commands[name]?.riskLevel === 'high'), unknown = chosen.filter(name => name !== 'sudo' && !commandRisks.commands[name]), overlap = chosen.filter(name => linesOf(denied.value).includes(name));
    capability.hidden = !chosen.length;
    capability.textContent = '명령 이름에 대한 기본 안내: 높은 위험 ' + high.length + '개' + (high.length ? ' (' + nameSummary(high) + ')' : '') + ' · 정보 없음 ' + unknown.length + '개' + (unknown.length ? ' (' + nameSummary(unknown) + ')' : '') + '. 낮음도 인자·대상·출력 저장의 안전을 보장하지 않습니다.' + (overlap.length ? ' 금지 목록과 겹침: ' + nameSummary(overlap) + ' — 금지가 우선합니다.' : '');
    renderSelected();
    const selected = commands.value.split(/\r?\n/).map(line => line.trim());
    for (const input of searchResults.querySelectorAll('input')) input.checked = selected.includes(input.value);
    scoreBox.hidden = !disclosure.checked && !execution.checked && !original?.thresholds.jev;
    transmissionNote.hidden = !execution.checked || disclosure.checked;
    transmissionNote.textContent = '정보 전송을 허용하지 않아 Jev 자동 실행은 작동하지 않습니다. 등록 명령의 자동승인은 유지됩니다.';
    for (const [provider, inputs] of Object.entries(scores)) {
      const threshold = original?.thresholds[provider], isLegacy = legacy(threshold) && !converted.has(provider);
      inputs.box.hidden = provider !== 'jev' && !threshold && fallback.value !== provider;
      inputs.old.hidden = !isLegacy; inputs.score.disabled = isLegacy; inputs.model.disabled = isLegacy;
    }
    const active = Object.keys(original?.thresholds ?? {}).join(', ') || '없음';
    advancedHeading.textContent = '고급 설정 · 금지 ' + (original?.deniedCommands.length ?? 0) + '개 · 대체 ' + (original?.fallback ?? '없음');
    advancedNote.textContent = '저장된 점수 설정: ' + active + '. 수정하지 않은 값은 그대로 보존합니다. 연결 상태는 미확인입니다.';
    summary.replaceChildren(el('strong', (nameOf(target.value) || '서버') + '에 적용할 내용'));
    const lines = ['명령 ' + commands.value.split(/\r?\n/).filter(line => line.trim()).length + '개 · 금지 명령 ' + denied.value.split(/\r?\n/).filter(line => line.trim()).length + '개',
      '정보 전송 ' + (disclosure.checked ? '허용 (위험도 확인부터 전송)' : '허용 안 함') + ' · Jev 기준 자동 실행 ' + (execution.checked ? '사용 (명령셋 밖도 포함)' : '사용 안 함')];
    const threshold = original?.thresholds.jev;
    if (threshold || execution.checked || changed.has('jev')) lines.push('Jev 기준 ' + probability.value + '% · ' + (legacy(threshold) && !converted.has('jev') ? '이전 방식 보존' : '낮은 위험 점수 방식 · 사용자 선택 기준'));
    if (changed.has('jev') && scores.jev.model.value !== (original?.thresholds.jev?.model ?? 'jev-1.14.0')) lines.push('Jev 모델 변경: ' + scores.jev.model.value);
    if (converted.size) lines.push('점수 방식 전환: ' + [...converted].join(', ') + ' · 기존 confidence 조건 제거');
    if (fallback.value) lines.push('대체 평가자 ' + fallback.value + ' · 연결 상태 미확인');
    for (const line of lines) summary.append(el('p', line));
    for (const [label, value, before] of [['자동승인 명령', chosen, original?.commands ?? []], ['금지 명령', linesOf(denied.value), original?.deniedCommands ?? []]]) {
      const added = value.filter(name => !before.includes(name)), removed = before.filter(name => !value.includes(name));
      summary.append(el('p', label + ' 추가: ' + (nameSummary(added) || '없음') + ' · 제외: ' + (nameSummary(removed) || '없음')));
      if (added.length > 8 || removed.length > 8) { const details = el('details', '', 'policy-details'); details.append(el('summary', label + ' 전체 변경 내역 · 추가 ' + added.length + '개 · 제외 ' + removed.length + '개'), el('p', '추가: ' + (added.join(', ') || '없음')), el('p', '제외: ' + (removed.join(', ') || '없음'))); summary.append(details); }
    }
    for (const [label, input, prior] of [['업로드', uploads, original?.automaticUploads], ['다운로드', downloads, original?.automaticDownloads], ['sudo', sudo, original?.automaticSudo], ['AI 평가 자동승인', execution, original?.modelExecution], ['정보 전송', disclosure, original?.externalDisclosure]]) if (input.checked !== (prior === true)) summary.append(el('p', label + ' 변경: ' + (prior === true ? '허용' : '허용 안 함') + ' → ' + (input.checked ? '허용' : '허용 안 함')));
    for (const [provider, inputs] of Object.entries(scores)) if (changed.has(provider)) summary.append(el('p', provider + ' 모델·기준: ' + (original?.thresholds[provider]?.model ?? '미설정') + ' / ' + (original?.thresholds[provider] ? original.thresholds[provider].minLowRisk * 100 + '%' : '미설정') + ' → ' + inputs.model.value + ' / ' + inputs.score.value + '%'));
    if ((fallback.value || null) !== (original?.fallback ?? null)) summary.append(el('p', '대체 평가자 변경: ' + (original?.fallback ?? '없음') + ' → ' + (fallback.value || '없음')));
    summary.append(el('p', 'sudo 자동승인 ' + (sudo.checked ? '허용 · 내부 명령까지 등록 검사 · 권한 상승 포함' : '허용 안 함 · sudo마다 개별 승인')));
    summary.append(el('p', '파일 자동업로드 ' + (uploads.checked ? '허용 · 폴더 제한 없이 SSH 계정이 쓸 수 있는 경로에 새 파일 저장 · 설정/인증/자동 실행 파일도 포함 · Jev 내용 검사 없음 · 덮어쓰기/sudo 제외' : '허용 안 함 · 전송마다 승인')));
    summary.append(el('p', '파일 자동다운로드 ' + (downloads.checked ? '허용 · 읽을 수 있는 일반 파일 준비 · 개인정보/인증 파일 포함 가능 · Jev 내용 검사 없음 · sudo는 별도 허용 필요' : '허용 안 함 · 전송마다 승인')));
  }
  function show() {
    currentTarget = target.value; conflict = false;
    original = snapshot.targets.find(rule => rule.targetId === target.value);
    changed.clear(); converted.clear(); clearFieldErrors(); loadHint.hidden = true; invalidate('설정을 확인하고 위험도 확인을 눌러주세요.');
    commands.value = (original ? original.commands : Object.keys(RECOMMENDED)).join('\n'); denied.value = (original?.deniedCommands ?? []).join('\n');
    search.value = ''; renderSearch();
    disclosure.checked = original?.externalDisclosure ?? false; execution.checked = original?.modelExecution ?? false; fallback.value = original?.fallback ?? '';
    uploads.checked = original?.automaticUploads === true; downloads.checked = original?.automaticDownloads === true; sudo.checked = original?.automaticSudo === true;
    for (const [provider, inputs] of Object.entries(scores)) {
      const catalog = snapshot.evaluators?.[provider], saved = original?.thresholds[provider]?.model;
      const available = catalog?.models ?? (provider === 'jev' ? ['jev-1.14.0', 'jev-1.13.0'] : []);
      const chosen = saved ?? catalog?.defaultModel ?? available[0] ?? '';
      inputs.model.replaceChildren();
      for (const value of [...new Set([...available, ...(chosen ? [chosen] : [])])]) { const option = el('option', value + (!available.includes(value) ? ' · 저장된 선택' : '')); option.value = value; inputs.model.append(option); }
      if (!inputs.model.options.length) { const option = el('option', '연결된 모델 없음'); option.value = ''; inputs.model.append(option); }
      inputs.model.value = chosen;
      inputs.score.value = String((original?.thresholds[provider]?.minLowRisk ?? 0.9) * 100);
    }
    for (const option of fallback.options) if (option.value) option.disabled = !snapshot.evaluators?.[option.value]?.configured && option.value !== original?.fallback;
    modelNote.textContent = '모델 목록은 24시간마다 갱신합니다. 저장된 모델은 자동으로 바뀌지 않습니다.' + (snapshot.evaluators?.status === 'unavailable' ? ' 현재 목록 갱신에 실패해 이전 목록을 표시합니다.' : '') + ' 대체 평가는 서버에 연결된 모델만 선택할 수 있습니다.';
    message.textContent = original ? nameOf(target.value) + ' · ' + original.commands.length + '개 명령이 저장돼 있습니다.' : nameOf(target.value) + ' · 기본 선택을 초안에 채웠습니다. 아직 적용되지 않았습니다. 위험도 확인 후 저장하세요.';
    const draft = drafts.get(target.value);
    if (draft) {
      if (same(draft.binding, bindingOf(target.value)) && same(draft.original, original)) {
        rawInputs().forEach((input, i) => { if (input.type === 'checkbox') input.checked = draft.values[i]; else { if (input.tagName === 'SELECT' && ![...input.options].some(o => o.value === draft.values[i])) { const option = el('option', draft.values[i] + ' · 보존한 초안'); option.value = draft.values[i]; input.append(option); } input.value = draft.values[i]; } });
        draft.changed.forEach(p => changed.add(p)); draft.converted.forEach(p => converted.add(p)); loadHint.hidden = false;
        announce(next, '보존한 초안입니다. 위험도 확인과 OK를 다시 진행해 주세요.');
      } else {
        conflict = true; preserve(draft); conflictText.textContent = '서버의 정책 또는 연결 정보가 바뀌었습니다. 초안은 보존했으며 자동 병합하지 않습니다. 최신 설정으로 새 초안을 시작해 주세요.';
      }
    }
    if (!conflict) { conflictBox.hidden = !archives.has(target.value); latest.hidden = true; if (archives.has(target.value)) { preserve(archives.get(target.value)); conflictText.textContent = '이전 초안은 참고용으로 보존됐습니다. 현재 입력에 자동 적용하지 않습니다.'; } }
    else latest.hidden = false;
    renderSearch(); update(); lock();
  }
  latest.onclick = () => { drafts.delete(target.value); show(); commands.focus(); };
  async function load() {
    if (loading || busy) return;
    const selectedTarget = target.value; remember();
    loading = true; invalidate('서버 설정을 불러오는 중입니다.'); fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; reviewButton.disabled = true; error(''); message.textContent = '서버 설정을 불러오는 중입니다…';
    try {
      const fresh = await api('/api/command-policy');
      const unresolved = unknownSave; snapshot = fresh; target.replaceChildren();
      for (const binding of snapshot.bindings) { const option = el('option', binding.displayName); option.value = binding.targetId; target.append(option); }
      if (snapshot.bindings.some(b => b.targetId === selectedTarget)) target.value = selectedTarget;
      target.parentElement.hidden = snapshot.bindings.length === 1; fields.hidden = false;
      if (unresolved) {
        unknownSave = undefined; reconcile.hidden = true;
        const current = snapshot.targets.find(rule => rule.targetId === unresolved.targetId), requested = unresolved.candidate.policy.targets.find(rule => rule.targetId === unresolved.targetId);
        const matches = same(current, requested) && same(unresolved.draft.binding, bindingOf(unresolved.targetId));
        if (matches) { drafts.delete(unresolved.targetId); archives.set(unresolved.targetId, unresolved.draft); }
        show(); announce(message, matches ? '현재 적용값은 요청한 설정과 같습니다. 이전 저장 요청의 성공 여부를 단정하지 않습니다.' : '현재 적용값과 요청한 설정이 다릅니다. 보존한 초안과 비교해 주세요.');
      } else show();
    } catch (failure) { message.textContent = '설정을 불러오지 못했습니다. 로그인 상태를 확인한 뒤 다시 불러오세요.'; if (!unknownSave) importantStatus.textContent = '현재 적용값을 확인하지 못했습니다. 마지막 확인값은 최신이 아닐 수 있습니다.'; error('로그인 상태를 확인한 뒤 다시 불러오세요. ' + failure.message); }
    finally { loading = false; lock(); }
  }
  root.ontoggle = () => { if (root.open && !snapshot && !loading && (document.body.dataset.authMode === 'access' || document.querySelector('#token')?.value)) load(); }; reload.onclick = quickLoad.onclick = reconcile.onclick = load;
  document.querySelector('#load')?.addEventListener('click', () => { if (!snapshot) load(); });
  if (document.body.dataset.authMode === 'access') queueMicrotask(load);
  target.onchange = () => { remember(); error(''); show(); };
  form.oninput = event => {
    if (event.target === acknowledged || event.target === target || event.target === search || event.target === selectedFilter || searchResults.contains(event.target) || selectedList.contains(event.target)) return;
    for (const [provider, inputs] of Object.entries(scores)) if ([inputs.model, inputs.score].includes(event.target)) changed.add(provider);
    loadHint.hidden = false; error(''); clearFieldErrors(); invalidate();
    if ([uploads, downloads, sudo, execution].includes(event.target)) { onNavigate(); root.open = true; }
    update();
  };
  function renderSelected() {
    const names = [...new Set(linesOf(commands.value))], query = selectedFilter.value.trim().toLowerCase(), matches = names.filter(name => name.toLowerCase().includes(query));
    selectedList.replaceChildren(); announce(selectedStatus, '선택 ' + names.length + '개 · 일치 ' + matches.length + '개 · 표시 ' + Math.min(selectedLimit, matches.length) + '개');
    for (const name of matches.slice(0, selectedLimit)) {
      const risk = commandRisks.commands[name] ?? commandRisks.defaultRisk, row = el('li', '', 'policy-selected-row');
      const text = el('span'); text.append(el('strong', name), el('small', (risk.description ?? (name === 'sudo' ? '별도 sudo 설정으로 관리' : '내장 안내 없음')) + ' · 기본 위험 ' + riskLabel(risk.riskLevel)), el('small', risk.reason));
      const remove = el('button', '제외', 'secondary'); remove.type = 'button'; remove.setAttribute('aria-label', name + ' 제외'); row.append(text, remove); selectedList.append(row);
      remove.onclick = () => {
        const at = [...selectedList.querySelectorAll('button')].indexOf(remove);
        commands.value = commands.value.split(/\r?\n/).filter(line => line.trim() !== name).join('\n');
        invalidate('명령을 제외했습니다. 금지한 것은 아닙니다. 위험도를 다시 확인해 주세요.'); loadHint.hidden = false; update();
        const buttons = [...selectedList.querySelectorAll('button')]; (buttons[Math.min(at, buttons.length - 1)] ?? selectedFilter).focus();
      };
    }
    if (matches.length > selectedLimit) { const more = el('button', '선택 명령 12개 더 보기', 'secondary'); more.type = 'button'; more.onclick = () => { selectedLimit += 12; renderSelected(); const rows = selectedList.querySelectorAll('li'); rows[selectedLimit - 12]?.querySelector('button')?.focus(); }; selectedList.append(more); }
  }
  selectedFilter.oninput = () => { selectedLimit = 12; renderSelected(); };
  selectedFilter.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
  function renderSearch() {
    const query = search.value.trim().toLowerCase(); searchResults.replaceChildren(); searchResults.hidden = !query;
    if (!query) { announce(searchStatus, '명령 이름이나 하고 싶은 일을 검색하세요. 내장 목록 밖 명령도 직접 입력할 수 있습니다.'); return; }
    const terms = query.split(/\s+/), matches = CATALOG.filter(item => terms.every(term => item.join(' ').toLowerCase().includes(term))).sort((a, b) => Number(b[0] === query) - Number(a[0] === query));
    announce(searchStatus, matches.length ? matches.length + '개 검색 결과 · ' + Math.min(searchLimit, matches.length) + '개 표시 · 체크하면 초안에 추가됩니다.' : '검색 결과가 없습니다. 아래에 명령 이름을 직접 입력할 수 있습니다.');
    for (const [name, description, category] of matches.slice(0, searchLimit)) {
      const risk = commandRisks.commands[name], label = el('label', '', 'policy-command-option'), input = el('input'); input.type = 'checkbox'; input.value = name; input.setAttribute('aria-label', name + ' 선택');
      const text = el('span'), help = el('small', description + ' · ' + category + ' · 기본 위험 ' + riskLabel(risk.riskLevel) + ' — ' + risk.reason); help.id = 'policy-command-help-' + name; input.setAttribute('aria-describedby', help.id);
      text.append(el('strong', name), help); label.append(input, text); searchResults.append(label);
      input.onchange = () => {
        const lines = commands.value.split(/\r?\n/), selected = linesOf(commands.value);
        if (input.checked && !selected.includes(name) && selected.length >= 128) { input.checked = false; error('자동승인 명령은 최대 128개까지 등록할 수 있습니다.'); return; }
        commands.value = (input.checked ? [...lines.filter(line => line.trim()), name] : lines.filter(line => line.trim() !== name)).join('\n');
        loadHint.hidden = false; invalidate('선택한 명령이 바뀌었습니다. 위험도를 다시 확인해 주세요.'); error(''); update();
      };
    }
    const selected = linesOf(commands.value); for (const input of searchResults.querySelectorAll('input')) input.checked = selected.includes(input.value);
    if (matches.length > searchLimit) { const more = el('button', '검색 결과 12개 더 보기', 'secondary'); more.type = 'button'; more.onclick = () => { const previous = searchLimit; searchLimit += 12; renderSearch(); searchResults.querySelectorAll('input')[previous]?.focus(); }; searchResults.append(more); }
  }
  search.oninput = () => { searchLimit = 12; renderSearch(); };
  search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
  for (const [provider, inputs] of Object.entries(scores)) inputs.convert.onclick = () => { converted.add(provider); changed.add(provider); invalidate('점수 방식 전환을 선택했습니다. 변경 내용과 위험도를 확인해 주세요.'); update(); };
  acknowledged.onchange = () => {
    if (!reviewed || Date.now() >= reviewed.expiresAt) { invalidate('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.'); return; }
    save.disabled = !acknowledged.checked; announce(next, acknowledged.checked ? '확인한 설정을 이 서버에 저장할 수 있습니다.' : '위험도와 변경 내용을 읽고 OK를 체크해 주세요.');
  };
  function proposal() {
    const binding = snapshot.bindings.find(item => item.targetId === target.value);
    if (!binding || original && (original.targetRevision !== binding.targetRevision || original.profile !== binding.profile)) throw Error('서버 연결 정보가 기존 정책과 다릅니다. 자동으로 연결을 바꾸지 않습니다. 관리자에게 확인해 주세요.');
    const rule = original ? structuredClone(original) : { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, commands: [], deniedCommands: [], externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {} };
    Object.assign(rule, { commands: names(commands, '자동승인 명령'), deniedCommands: names(denied, '금지 명령'), externalDisclosure: disclosure.checked, modelExecution: execution.checked, fallback: fallback.value || null });
    if (uploads.checked || Object.hasOwn(rule, 'automaticUploads')) rule.automaticUploads = uploads.checked;
    if (downloads.checked || Object.hasOwn(rule, 'automaticDownloads')) rule.automaticDownloads = downloads.checked;
    if (sudo.checked || Object.hasOwn(rule, 'automaticSudo')) rule.automaticSudo = sudo.checked;
    for (const [provider, inputs] of Object.entries(scores)) {
      if (!changed.has(provider) && !(provider === 'jev' && !rule.thresholds.jev && execution.checked)) continue;
      if (legacy(rule.thresholds[provider]) && !converted.has(provider)) throw Error('이전 점수 방식은 명시적으로 전환해야 변경할 수 있습니다.');
      const score = Number(inputs.score.value) / 100;
      if (!inputs.score.value || !Number.isFinite(score) || score <= 0.5 || score > 1) invalid(inputs.score, '50%보다 크고 100% 이하인 값을 입력해 주세요. 예: 90');
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(inputs.model.value)) invalid(inputs.model, '연결된 모델을 선택해 주세요.');
      rule.thresholds[provider] = { model: inputs.model.value, questionVersion: CURRENT, basis: BASIS, minLowRisk: score, validationRef: 'user-choice:' + Date.now() + ':' + globalThis.crypto.randomUUID() };
    }
    const policy = structuredClone({ targets: snapshot.targets });
    const index = policy.targets.findIndex(item => item.targetId === rule.targetId);
    if (index < 0) policy.targets.push(rule); else policy.targets[index] = rule;
    return { expectedRevision: snapshot.revision, policy };
  }
  reviewButton.onclick = async () => {
    if (!snapshot || busy || loading || unknownSave || conflict) return;
    invalidate('위험도를 확인할 준비를 합니다.'); error(''); clearFieldErrors(); let candidate;
    try { candidate = proposal(); } catch (failure) { if (!failure.field) error(failure.message); return; }
    const revision = generation, focusAtStart = document.activeElement; busy = true; reviewButton.disabled = true; reload.disabled = true; announce(next, '위험도를 확인하는 중입니다…');
    try {
      const result = await api('/api/command-policy/review', 'POST', candidate);
      if (revision !== generation) return;
      if (Date.now() >= result.expiresAt) { invalidate('확인 결과가 만료됐습니다. 위험도를 다시 확인해 주세요.'); return; }
      reviewed = { ...result, candidate };
      feedback.append(el('h4', '저장 전 확인해 주세요'), el('p', result.notice));
      if (!result.feedback.length) feedback.append(el('p', '저장된 설정과 같습니다. 새 평가 결과는 없습니다.'));
      const labels = { low_risk: '낮음', high_risk: '높음', uncertain: '판단 불충분' };
      for (const item of result.feedback) {
        const card = el('div', '', 'policy-risk'); card.dataset.level = item.level;
        card.append(el('strong', nameOf(item.targetId) + ' · 종합 위험도 ' + labels[item.level]), el('p', nameSummary(item.commands) || '등록할 명령 없음'));
        card.append(el('p', '서버의 등록 규칙과 사용 가능한 Jev 평가를 반영한 안내입니다. 파일 자동업로드나 영향이 큰 명령은 서버 규칙에서 높은 위험으로 안내합니다.'));
        if (item.assessment) {
          card.append(el('p', 'Jev 분류: ' + labels[item.assessment.label] + ' · 구체적인 위험 사유는 제공되지 않았습니다.'));
          const details = el('details'); details.append(el('summary', '평가 상세'), el('p', '낮은 위험 점수 ' + (item.assessment.probabilities.low_risk * 100).toFixed(1) + '% · 실제 안전을 보증하지 않습니다.')); card.append(details);
        } else card.append(el('p', '평가가 없다는 것이 안전하다는 뜻은 아닙니다. 아래 경고를 읽어주세요.'));
        if (item.commandRisks?.length) { const definitions = el('details'); definitions.append(el('summary','명령별 기본 위험도 · 등록 안내')); for (const risk of item.commandRisks) definitions.append(el('p', risk.name + ' · ' + ({low:'낮음',moderate:'보통',high:'높음',unknown:'정보 없음'}[risk.riskLevel] ?? '정보 없음') + ' · ' + risk.reason)); card.append(definitions); }
        card.append(el('p', item.warning)); feedback.append(card);
      }
      confirmation.hidden = false; acknowledged.disabled = false; announce(next, '위험도와 변경 내용을 읽고 OK를 체크해 주세요.');
      expiry = setTimeout(() => invalidate('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.'), result.expiresAt - Date.now());
      if (document.activeElement === focusAtStart || document.activeElement === document.body) feedback.focus();
    } catch (failure) { if (revision === generation) { error('위험도를 확인하지 못했습니다. 입력은 유지됩니다. ' + failure.message); invalidate('위험도를 확인하지 못했습니다. 입력은 유지됩니다. 다시 확인해 주세요.'); } }
    finally { busy = false; lock(); }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!reviewed || !acknowledged.checked || busy || unknownSave || conflict) return;
    if (Date.now() >= reviewed.expiresAt) { invalidate('확인 결과가 만료됐습니다. 위험도를 다시 확인해 주세요.'); return; }
    remember(); const checked = reviewed, draft = drafts.get(target.value), submittedTarget = target.value; clearTimeout(expiry); busy = true; fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; save.disabled = true; error('');
    try {
      const result = await api('/api/command-policy', 'POST', { ...checked.candidate, reviewToken: checked.reviewToken, acknowledged: true });
      snapshot = { ...result, bindings: snapshot.bindings, evaluators: snapshot.evaluators }; drafts.delete(submittedTarget); const server = nameOf(target.value); show();
      message.textContent = server + '에 명령 ' + (original?.commands.length ?? 0) + '개를 저장했습니다.'; announce(next, '저장 완료. 이후 요청부터 이 설정을 적용합니다.');
    } catch (failure) { unknownSave = { candidate: checked.candidate, targetId: submittedTarget, draft }; reconcile.hidden = false; preserve(draft); latest.hidden = true; conflictText.textContent = '저장 요청에 보낸 초안입니다. 현재 적용값은 아직 확인하지 못했습니다.'; invalidate('저장 결과를 확인하지 못했습니다. 이미 적용됐을 수 있습니다. 현재 적용 설정 확인을 눌러주세요.'); error('저장을 확인하지 못했습니다. ' + failure.message); reconcile.focus(); }
    finally { busy = false; update(); lock(); }
  };
}
