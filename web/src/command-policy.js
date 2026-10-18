import commandRisks from '../../src/domain/command-risks.json' with { type: 'json' };
const RECOMMENDED = Object.fromEntries(commandRisks.defaultCommands.map(name => [name, commandRisks.commands[name].description]));
const CATALOG = Object.entries(commandRisks.commands).map(([name, value]) => [name, value.description, value.category]);
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
  root.append(el('summary', '자동승인 설정'), el('p', '기본 조회 명령이 준비돼 있습니다. 필요한 명령을 검색해 고르고, 위험도를 확인한 뒤 저장하세요.', 'policy-intro'));
  const reload = el('button', '다시 불러오기', 'secondary'); reload.type = 'button'; reload.setAttribute('aria-label', '서버 설정 다시 불러오기');
  const message = el('p', '', 'policy-message'); message.setAttribute('role', 'status');
  const toolbar = el('div', '', 'policy-toolbar'); toolbar.append(message, reload); root.append(toolbar);
  const loadHint = el('p', '다시 불러오면 저장하지 않은 입력은 지워집니다.', 'policy-help'); loadHint.hidden = true; root.append(loadHint);
  const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert'); failure.hidden = true; root.append(failure);
  const form = el('form'); form.className = 'policy-form';
  const important = el('section', '', 'request policy-editor important-settings'); important.id = 'important-settings';
  important.append(el('h2', '중요 자동승인 설정'), el('p', '파일 업로드·다운로드·sudo와 AI 평가를 통한 자동승인 허용 여부를 서버별로 설정합니다. 변경 후 위험도 확인·OK·저장을 거쳐야 적용됩니다.', 'policy-help'));
  const importantFields = el('fieldset', '', 'policy-fields'); importantFields.disabled = true; important.append(importantFields);
  const importantStatus = el('p', '서버 설정을 불러오면 현재 허용 상태를 표시합니다.', 'policy-message'); importantStatus.setAttribute('role','status'); important.append(importantStatus);
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
  const search = field(one, '명령 검색', 'input', 'search', '자주 쓰는 Linux 명령을 이름이나 설명으로 찾습니다. 검색은 서버에서 명령을 실행하지 않습니다.');
  search.placeholder = '예: grep, 파일 찾기, 프로세스'; search.autocomplete = 'off'; search.maxLength = 100;
  const searchStatus = el('p', '', 'policy-help'); searchStatus.setAttribute('role', 'status'); one.append(searchStatus);
  const searchResults = el('div', '', 'policy-search-results'); searchResults.setAttribute('role', 'group'); searchResults.setAttribute('aria-label', '명령 검색 결과'); searchResults.hidden = true; one.append(searchResults);
  const commands = field(one, '자동승인할 명령', 'textarea', '', '이름만 한 줄에 하나. 예: ls (-l 같은 옵션은 빼주세요.)'); commands.rows = 5; commands.spellcheck = false;
  const count = el('p', '', 'policy-help'); one.append(count);
  one.append(el('p', '명령줄의 명령이 모두 사전승인 목록에 있으면 인자 위험도·Jev 평가 없이 실행합니다. 하나라도 미등록이면 전체 명령줄을 Jev로 평가합니다.', 'policy-help'));
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
    old.append(el('p', '이전 점수 방식이 저장돼 있습니다. 명령만 바꾸면 그대로 보존합니다. 전환하면 기존 confidence 조건을 없애고 안전 확률 하나를 쓰며, Jev 자동 실행이 켜져 있다면 실행 가능 범위가 달라질 수 있습니다.'), convert);
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
  const next = el('p', '먼저 위험도를 확인해 주세요.', 'policy-help'); three.append(next);
  document.querySelector('.grid').before(form);

  let snapshot, original, reviewed, generation = 0, expiry, busy = false, loading = false;
  const changed = new Set(), converted = new Set();
  const nameOf = id => snapshot?.bindings.find(binding => binding.targetId === id)?.displayName ?? id;
  const error = text => { failure.textContent = text; failure.hidden = !text; };
  const clearFieldErrors = () => { for (const [input, note] of fieldErrors) { note.hidden = true; note.textContent = ''; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-errormessage'); } };
  const invalid = (input, message) => {
    const note = fieldErrors.get(input); note.textContent = message; note.hidden = false;
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-errormessage', note.id); input.focus();
    const failure = Error(message); failure.field = true; throw failure;
  };
  const invalidate = (text = '내용이 바뀌었습니다. 위험도를 다시 확인해 주세요.') => {
    generation++; clearTimeout(expiry); reviewed = undefined; acknowledged.checked = false; acknowledged.disabled = true; save.disabled = true; confirmation.hidden = true; feedback.replaceChildren(); next.textContent = text;
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
      importantStatus.textContent = nameOf(target.value) + ' · 저장된 설정: 파일 업로드 ' + (original?.automaticUploads === true ? '허용' : '개별 승인') + ' · 다운로드 ' + (original?.automaticDownloads === true ? '허용' : '개별 승인') + ' · sudo ' + (original?.automaticSudo === true ? '허용' : '개별 승인') + ' · AI 평가 자동승인 ' + (original?.modelExecution === true ? '허용' : '개별 승인') + (dirty ? ' · 변경 사항은 아직 저장되지 않았습니다.' : '');
    }
    count.textContent = commands.value.split(/\r?\n/).filter(line => line.trim()).length + '개 입력 · 최대 128개';
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
    if (threshold || execution.checked || changed.has('jev')) lines.push('Jev 기준 ' + probability.value + '% · ' + (legacy(threshold) && !converted.has('jev') ? '이전 방식 보존' : '안전 확률 방식 · 사용자 선택 기준'));
    if (changed.has('jev') && scores.jev.model.value !== (original?.thresholds.jev?.model ?? 'jev-1.14.0')) lines.push('Jev 모델 변경: ' + scores.jev.model.value);
    if (converted.size) lines.push('점수 방식 전환: ' + [...converted].join(', ') + ' · 기존 confidence 조건 제거');
    if (fallback.value) lines.push('대체 평가자 ' + fallback.value + ' · 연결 상태 미확인');
    for (const line of lines) summary.append(el('p', line));
    summary.append(el('p', 'sudo 자동승인 ' + (sudo.checked ? '허용 · 내부 명령까지 등록 검사 · 권한 상승 포함' : '허용 안 함 · sudo마다 개별 승인')));
    summary.append(el('p', '파일 자동업로드 ' + (uploads.checked ? '허용 · 폴더 제한 없이 SSH 계정이 쓸 수 있는 경로에 새 파일 저장 · 설정/인증/자동 실행 파일도 포함 · Jev 내용 검사 없음 · 덮어쓰기/sudo 제외' : '허용 안 함 · 전송마다 승인')));
    summary.append(el('p', '파일 자동다운로드 ' + (downloads.checked ? '허용 · 읽을 수 있는 일반 파일 준비 · 개인정보/인증 파일 포함 가능 · Jev 내용 검사 없음 · sudo는 별도 허용 필요' : '허용 안 함 · 전송마다 승인')));
  }
  function show() {
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
    message.textContent = original ? nameOf(target.value) + ' · ' + original.commands.length + '개 명령이 저장돼 있습니다.' : nameOf(target.value) + ' · 기본 조회 명령을 초안에 채웠습니다. 위험도 확인 후 저장하세요.';
    update();
  }
  async function load() {
    if (loading || busy) return;
    loading = true; invalidate('서버 설정을 불러오는 중입니다.'); fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; reviewButton.disabled = true; error(''); message.textContent = '서버 설정을 불러오는 중입니다…';
    try {
      snapshot = await api('/api/command-policy'); target.replaceChildren();
      for (const binding of snapshot.bindings) { const option = el('option', binding.displayName); option.value = binding.targetId; target.append(option); }
      target.parentElement.hidden = snapshot.bindings.length === 1; fields.hidden = false; show();
    } catch (failure) { message.textContent = importantStatus.textContent = '설정을 불러오지 못했습니다. 로그인 상태를 확인한 뒤 다시 불러오세요.'; error('로그인 상태를 확인한 뒤 다시 불러오세요. ' + failure.message); }
    finally { loading = false; fields.disabled = importantFields.disabled = !snapshot; reload.disabled = quickLoad.disabled = false; reviewButton.disabled = false; }
  }
  root.ontoggle = () => { if (root.open && !snapshot && !loading && (document.body.dataset.authMode === 'access' || document.querySelector('#token')?.value)) load(); }; reload.onclick = quickLoad.onclick = load;
  document.querySelector('#load')?.addEventListener('click', () => { if (!snapshot) load(); });
  if (document.body.dataset.authMode === 'access') queueMicrotask(load);
  target.onchange = () => { error(''); show(); };
  form.oninput = event => {
    if (event.target === acknowledged || event.target === target || event.target === search || searchResults.contains(event.target)) return;
    for (const [provider, inputs] of Object.entries(scores)) if ([inputs.model, inputs.score].includes(event.target)) changed.add(provider);
    loadHint.hidden = false; error(''); clearFieldErrors(); invalidate();
    if ([uploads, downloads, sudo, execution].includes(event.target)) { onNavigate(); root.open = true; }
    update();
  };
  function renderSearch() {
    const query = search.value.trim().toLowerCase(); searchResults.replaceChildren(); searchResults.hidden = !query;
    if (!query) { searchStatus.textContent = '명령 이름이나 하고 싶은 일을 검색하세요. 목록에 없는 명령은 아래에 직접 입력할 수 있습니다.'; return; }
    const terms = query.split(/\s+/), matches = CATALOG.filter(item => terms.every(term => item.join(' ').toLowerCase().includes(term)));
    searchStatus.textContent = matches.length ? matches.length + '개 검색 결과 · 체크하면 자동승인 초안에 추가됩니다.' : '검색 결과가 없습니다. 아래에 명령 이름을 직접 입력할 수 있습니다.';
    for (const [name, description, category] of matches.slice(0, 12)) {
      const label = el('label', '', 'policy-command-option'), input = el('input'); input.type = 'checkbox'; input.value = name; input.setAttribute('aria-label', name + ' 선택');
      const text = el('span'); text.append(el('strong', name), el('small', description + ' · ' + category)); label.append(input, text); searchResults.append(label);
      input.onchange = () => {
        const lines = commands.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (input.checked && !lines.includes(name) && lines.length >= 128) { input.checked = false; error('자동승인 명령은 최대 128개까지 등록할 수 있습니다.'); return; }
        commands.value = (input.checked ? [...lines.filter(item => item !== name), name] : lines.filter(item => item !== name)).join('\n');
        loadHint.hidden = false; invalidate('선택한 명령이 바뀌었습니다. 위험도를 다시 확인해 주세요.'); error(''); update();
      };
    }
    const selected = commands.value.split(/\r?\n/).map(line => line.trim());
    for (const input of searchResults.querySelectorAll('input')) input.checked = selected.includes(input.value);
    if (matches.length > 12) searchResults.append(el('p', '처음 12개를 표시합니다. 검색어를 더 입력해 범위를 좁혀주세요.', 'policy-help'));
  }
  search.oninput = renderSearch;
  search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
  for (const [provider, inputs] of Object.entries(scores)) inputs.convert.onclick = () => { converted.add(provider); changed.add(provider); invalidate('점수 방식 전환을 선택했습니다. 변경 내용과 위험도를 확인해 주세요.'); update(); };
  acknowledged.onchange = () => {
    if (!reviewed || Date.now() >= reviewed.expiresAt) { invalidate('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.'); return; }
    save.disabled = !acknowledged.checked; next.textContent = acknowledged.checked ? '확인한 설정을 이 서버에 저장할 수 있습니다.' : '위험도와 변경 내용을 읽고 OK를 체크해 주세요.';
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
    if (!snapshot || busy || loading) return;
    invalidate(); error(''); clearFieldErrors(); let candidate;
    try { candidate = proposal(); } catch (failure) { if (!failure.field) error(failure.message); return; }
    const revision = generation; busy = true; reviewButton.disabled = true; reload.disabled = true; next.textContent = '위험도를 확인하는 중입니다…';
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
        card.append(el('strong', nameOf(item.targetId) + ' · 종합 위험도 ' + labels[item.level]), el('p', item.commands.join(', ') || '등록할 명령 없음'));
        card.append(el('p', '서버의 등록 규칙과 사용 가능한 Jev 평가를 반영한 안내입니다. 파일 자동업로드나 영향이 큰 명령은 서버 규칙에서 높은 위험으로 안내합니다.'));
        if (item.assessment) {
          card.append(el('p', 'Jev 분류: ' + labels[item.assessment.label] + ' · 구체적인 위험 사유는 제공되지 않았습니다.'));
          const details = el('details'); details.append(el('summary', '평가 상세'), el('p', '낮은 위험 점수 ' + (item.assessment.probabilities.low_risk * 100).toFixed(1) + '% · 실제 안전을 보증하지 않습니다.')); card.append(details);
        } else card.append(el('p', '평가가 없다는 것이 안전하다는 뜻은 아닙니다. 아래 경고를 읽어주세요.'));
        if (item.commandRisks?.length) { const definitions = el('details'); definitions.append(el('summary','명령별 기본 위험도 · 등록 안내')); for (const risk of item.commandRisks) definitions.append(el('p', risk.name + ' · ' + ({low:'낮음',moderate:'보통',high:'높음',unknown:'정보 없음'}[risk.riskLevel] ?? '정보 없음') + ' · ' + risk.reason)); card.append(definitions); }
        card.append(el('p', item.warning)); feedback.append(card);
      }
      confirmation.hidden = false; acknowledged.disabled = false; next.textContent = '위험도와 변경 내용을 읽고 OK를 체크해 주세요.';
      expiry = setTimeout(() => invalidate('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.'), result.expiresAt - Date.now());
      feedback.focus();
    } catch (failure) { if (revision === generation) { error('위험도를 확인하지 못했습니다. 입력은 유지됩니다. ' + failure.message); invalidate('위험도를 다시 확인해 주세요. 서버 설정이 바뀌었다면 다시 불러오세요.'); } }
    finally { busy = false; reviewButton.disabled = false; reload.disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!reviewed || !acknowledged.checked || busy) return;
    if (Date.now() >= reviewed.expiresAt) { invalidate('확인 결과가 만료됐습니다. 위험도를 다시 확인해 주세요.'); return; }
    const checked = reviewed; busy = true; fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; save.disabled = true; error('');
    try {
      const result = await api('/api/command-policy', 'POST', { ...checked.candidate, reviewToken: checked.reviewToken, acknowledged: true });
      snapshot = { ...result, bindings: snapshot.bindings, evaluators: snapshot.evaluators }; const server = nameOf(target.value); show();
      message.textContent = server + '에 명령 ' + (original?.commands.length ?? 0) + '개를 저장했습니다.'; next.textContent = '저장 완료. 이후 요청부터 이 설정을 적용합니다.';
    } catch (failure) { invalidate('저장 결과를 확인하지 못했습니다. 입력은 유지됩니다. 서버 설정을 다시 불러와 결과를 확인해 주세요.'); error('저장을 확인하지 못했습니다. ' + failure.message); }
    finally { busy = false; fields.disabled = importantFields.disabled = false; reload.disabled = quickLoad.disabled = false; update(); }
  };
}
