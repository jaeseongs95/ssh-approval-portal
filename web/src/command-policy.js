const RECOMMENDED = { pwd: '현재 위치', ls: '파일 목록', stat: '파일 정보', df: '디스크 여유 공간', du: '폴더 용량', uname: '시스템 정보', uptime: '가동 시간', whoami: '현재 사용자', id: '사용자 권한 정보', hostname: '서버 이름' };
// Local descriptions help selection; registration risk feedback remains authoritative.
const CATALOG = [...Object.entries(RECOMMENDED).map(([name, description]) => [name, description, '조회']),
  ['cat', '파일 내용 보기', '조회'], ['head', '파일 앞부분 보기', '조회'], ['tail', '파일 뒷부분과 로그 보기', '조회'],
  ['wc', '줄·단어·글자 수 세기', '조회'], ['grep', '파일 내용에서 글자나 문장 검색', '조회'], ['find', '파일·폴더 찾기', '조회·변경'],
  ['sort', '텍스트 줄 정렬', '조회·변경'], ['uniq', '연속으로 중복된 줄 정리', '조회'], ['ps', '실행 중인 프로세스 목록', '조회'],
  ['top', '프로세스와 CPU 사용량 보기', '조회'], ['free', '메모리 사용량 보기', '조회'], ['date', '날짜와 시간 확인·설정', '조회·변경'],
  ['ss', '네트워크 연결과 포트 보기', '조회'], ['ip', '네트워크 주소 확인·설정', '조회·변경'], ['ping', '네트워크 연결 확인', '네트워크'],
  ['curl', 'URL로 네트워크 요청 보내기', '네트워크·변경'], ['journalctl', '시스템 서비스 로그 확인·관리', '조회·변경'],
  ['systemctl', '서비스 상태 확인·시작·중지', '조회·변경'], ['cp', '파일 복사', '변경'], ['mv', '파일 이동·이름 변경', '변경'],
  ['mkdir', '폴더 만들기', '변경'], ['touch', '파일 만들기·수정 시각 변경', '변경'], ['rm', '파일·폴더 삭제', '삭제'],
  ['chmod', '파일 접근 권한 변경', '권한 변경'], ['chown', '파일 소유자 변경', '권한 변경'], ['tar', '파일 묶기·풀기', '조회·변경'],
  ['kill', '프로세스에 신호 보내기·종료', '변경'], ['sudo', '다른 사용자 권한으로 명령 실행', '권한 사용']];
const CURRENT = 'ssh-command-risk-v4', BASIS = 'safety-probability-v1';
const legacy = threshold => threshold && (threshold.questionVersion !== CURRENT || threshold.basis !== BASIS);

/** Preserve the owner policy; only explicitly edited settings become a proposal. */
export function createCommandPolicyEditor({ document, api }) {
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
  const form = el('form'); form.hidden = true; root.append(form);
  const fields = el('fieldset', '', 'policy-fields'); form.append(fields);
  const section = (number, title) => {
    const node = el('section', '', 'policy-section'); node.append(el('h3', number + '. ' + title)); fields.append(node); return node;
  };
  let fieldId = 0;
  const field = (parent, label, tag = 'input', type = 'text', hint = '') => {
    const box = el('label', '', 'policy-field'), input = el(tag);
    const caption = el('span', label); caption.id = 'policy-label-' + ++fieldId;
    input.setAttribute('aria-labelledby', caption.id); box.append(caption); if (tag === 'input') input.type = type;
    box.append(input); parent.append(box);
    if (hint) { const help = el('p', hint, 'policy-help'); help.id = 'policy-help-' + fieldId; input.setAttribute('aria-describedby', help.id); parent.append(help); }
    return input;
  };
  const check = (parent, title, explanation) => {
    const label = el('label', '', 'policy-check'), input = el('input'); input.type = 'checkbox';
    const text = el('span'); text.append(el('strong', title), el('small', explanation)); label.append(input, text); parent.append(label); return input;
  };
  const one = section(1, '명령 고르기');
  const target = field(one, '설정할 서버', 'select');
  const search = field(one, '명령 검색', 'input', 'search', '자주 쓰는 Linux 명령을 이름이나 설명으로 찾습니다. 검색은 서버에서 명령을 실행하지 않습니다.');
  search.placeholder = '예: grep, 파일 찾기, 프로세스'; search.autocomplete = 'off'; search.maxLength = 100;
  const searchStatus = el('p', '', 'policy-help'); searchStatus.setAttribute('role', 'status'); one.append(searchStatus);
  const searchResults = el('div', '', 'policy-search-results'); searchResults.setAttribute('role', 'group'); searchResults.setAttribute('aria-label', '명령 검색 결과'); searchResults.hidden = true; one.append(searchResults);
  const commands = field(one, '자동승인할 명령', 'textarea', '', '이름만 한 줄에 하나. 예: ls (-l 같은 옵션은 빼주세요.)'); commands.rows = 5; commands.spellcheck = false;
  const count = el('p', '', 'policy-help'); one.append(count);
  one.append(el('p', '등록된 조회 명령은 추가 승인 없이 실행됩니다. 위험 징후가 있으면 Jev나 사용자에게 확인합니다.', 'policy-help'));

  const two = section(2, 'Jev 도움받기');
  const disclosure = check(two, 'Jev에 정보 전송 허용', '명령·작업 상황·서버 정보를 TypeSafe의 Jev로 보냅니다. 저장 전 위험도 확인부터 전송됩니다.');
  const disclosureDetails = el('details', '', 'policy-details'); disclosureDetails.append(el('summary', '전송 정보 자세히 보기'), el('p', '등록 전에는 후보 명령셋·대상·프로필 정보를 보냅니다. 실행 판단에는 전체 명령, 작업 상황, 대상·프로필·접속대상, 명령셋과 사용자 명시적 승인 여부를 보냅니다.', 'policy-help')); two.append(disclosureDetails);
  const execution = check(two, 'Jev 판단으로도 자동승인', '목록 밖의 명령도 점수 기준을 넘으면 실행합니다. 끄면 등록한 조회 명령의 자동승인만 유지됩니다.');
  const transmissionNote = el('p', '', 'policy-warning'); two.append(transmissionNote);
  const scoreBox = el('div'); two.append(scoreBox);
  const probability = field(scoreBox, 'Jev 자동승인 기준 (%)', 'input', 'number', '모델이 제시한 안전 확률의 기준입니다. 실제 안전을 보증하지 않습니다.');
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
    const model = field(box, provider + ' 모델 ID');
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
  document.querySelector('.grid').before(root);

  let snapshot, original, reviewed, generation = 0, expiry, busy = false, loading = false;
  const changed = new Set(), converted = new Set();
  const nameOf = id => snapshot?.bindings.find(binding => binding.targetId === id)?.displayName ?? id;
  const error = text => { failure.textContent = text; failure.hidden = !text; };
  const invalidate = (text = '내용이 바뀌었습니다. 위험도를 다시 확인해 주세요.') => {
    generation++; clearTimeout(expiry); reviewed = undefined; acknowledged.checked = false; acknowledged.disabled = true; save.disabled = true; confirmation.hidden = true; feedback.replaceChildren(); next.textContent = text;
  };
  function names(input, label) {
    const result = [];
    for (const [index, line] of input.value.split(/\r?\n/).entries()) {
      const name = line.trim(); if (!name) continue;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(name)) throw Error(label + ' ' + (index + 1) + '번째 줄: 명령 이름만 입력하세요. 예: ls -l 대신 ls');
      if (result.includes(name)) throw Error(label + ' ' + (index + 1) + '번째 줄: ' + name + '이 중복됐습니다. 한 번만 남겨주세요.');
      result.push(name);
    }
    if (result.length > 128) throw Error(label + '은 최대 128개까지 등록할 수 있습니다.');
    return result;
  }
  function update() {
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
    if (changed.has('jev') && scores.jev.model.value !== (original?.thresholds.jev?.model ?? 'jev-1.13.0')) lines.push('Jev 모델 변경: ' + scores.jev.model.value);
    if (converted.size) lines.push('점수 방식 전환: ' + [...converted].join(', ') + ' · 기존 confidence 조건 제거');
    if (fallback.value) lines.push('대체 평가자 ' + fallback.value + ' · 연결 상태 미확인');
    for (const line of lines) summary.append(el('p', line));
  }
  function show() {
    original = snapshot.targets.find(rule => rule.targetId === target.value);
    changed.clear(); converted.clear(); loadHint.hidden = true; invalidate('설정을 확인하고 위험도 확인을 눌러주세요.');
    commands.value = (original ? original.commands : Object.keys(RECOMMENDED)).join('\n'); denied.value = (original?.deniedCommands ?? []).join('\n');
    search.value = ''; renderSearch();
    disclosure.checked = original?.externalDisclosure ?? false; execution.checked = original?.modelExecution ?? false; fallback.value = original?.fallback ?? '';
    for (const [provider, inputs] of Object.entries(scores)) {
      inputs.model.value = original?.thresholds[provider]?.model ?? (provider === 'jev' ? 'jev-1.13.0' : '');
      inputs.score.value = String((original?.thresholds[provider]?.minLowRisk ?? 0.9) * 100);
    }
    message.textContent = original ? nameOf(target.value) + ' · ' + original.commands.length + '개 명령이 저장돼 있습니다.' : nameOf(target.value) + ' · 기본 조회 명령을 초안에 채웠습니다. 위험도 확인 후 저장하세요.';
    update();
  }
  async function load() {
    if (loading || busy) return;
    loading = true; invalidate('서버 설정을 불러오는 중입니다.'); fields.disabled = true; reload.disabled = true; reviewButton.disabled = true; error(''); message.textContent = '서버 설정을 불러오는 중입니다…';
    try {
      snapshot = await api('/api/command-policy'); target.replaceChildren();
      for (const binding of snapshot.bindings) { const option = el('option', binding.displayName); option.value = binding.targetId; target.append(option); }
      target.parentElement.hidden = snapshot.bindings.length === 1; form.hidden = false; show();
    } catch (failure) { message.textContent = '설정을 불러오지 못했습니다.'; error('로그인 상태를 확인한 뒤 다시 불러오세요. ' + failure.message); }
    finally { loading = false; fields.disabled = false; reload.disabled = false; reviewButton.disabled = false; }
  }
  root.ontoggle = () => { if (root.open && !snapshot && !loading) load(); }; reload.onclick = load;
  target.onchange = () => { error(''); show(); };
  form.oninput = event => {
    if (event.target === acknowledged || event.target === target || event.target === search || searchResults.contains(event.target)) return;
    for (const [provider, inputs] of Object.entries(scores)) if ([inputs.model, inputs.score].includes(event.target)) changed.add(provider);
    loadHint.hidden = false; error(''); invalidate(); update();
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
    for (const [provider, inputs] of Object.entries(scores)) {
      if (!changed.has(provider) && !(provider === 'jev' && !rule.thresholds.jev && execution.checked)) continue;
      if (legacy(rule.thresholds[provider]) && !converted.has(provider)) throw Error('이전 점수 방식은 명시적으로 전환해야 변경할 수 있습니다.');
      const score = Number(inputs.score.value) / 100;
      if (!inputs.score.value || !Number.isFinite(score) || score <= 0.5 || score > 1) throw Error(provider + ' 기준은 50% 초과, 100% 이하로 입력해 주세요.');
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(inputs.model.value)) throw Error(provider + ' 모델 ID를 고급 설정에서 확인해 주세요.');
      rule.thresholds[provider] = { model: inputs.model.value, questionVersion: CURRENT, basis: BASIS, minLowRisk: score, validationRef: 'user-choice:' + Date.now() + ':' + globalThis.crypto.randomUUID() };
    }
    const policy = structuredClone({ targets: snapshot.targets });
    const index = policy.targets.findIndex(item => item.targetId === rule.targetId);
    if (index < 0) policy.targets.push(rule); else policy.targets[index] = rule;
    return { expectedRevision: snapshot.revision, policy };
  }
  reviewButton.onclick = async () => {
    if (!snapshot || busy || loading) return;
    invalidate(); error(''); let candidate;
    try { candidate = proposal(); } catch (failure) { error(failure.message); return; }
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
        const card = el('div', '', 'policy-risk'); card.dataset.level = item.assessment ? item.level : 'uncertain';
        card.append(el('strong', nameOf(item.targetId) + ' · ' + (item.assessment ? '위험도 ' + labels[item.level] : item.level === 'high_risk' ? '위험도 높음 · Jev 평가 미제공' : 'Jev 평가 미제공 · 판단 불충분')), el('p', item.commands.join(', ') || '등록할 명령 없음'));
        if (item.assessment) {
          card.append(el('p', 'Jev 안전 확률 ' + (item.assessment.probabilities.low_risk * 100).toFixed(1) + '% · 실제 안전을 보증하지 않습니다.'));
          const details = el('details'); details.append(el('summary', '평가 상세'), el('p', 'Jev 판정 ' + labels[item.assessment.label] + ' · 참고 confidence ' + item.assessment.confidence + ' (실행 기준 아님)')); card.append(details);
        } else card.append(el('p', '평가가 없다는 것이 안전하다는 뜻은 아닙니다. 아래 경고를 읽어주세요.'));
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
    const checked = reviewed; busy = true; fields.disabled = true; reload.disabled = true; save.disabled = true; error('');
    try {
      const result = await api('/api/command-policy', 'POST', { ...checked.candidate, reviewToken: checked.reviewToken, acknowledged: true });
      snapshot = { ...result, bindings: snapshot.bindings }; const server = nameOf(target.value); show();
      message.textContent = server + '에 명령 ' + (original?.commands.length ?? 0) + '개를 저장했습니다.'; next.textContent = '저장 완료. 이후 요청부터 이 설정을 적용합니다.';
    } catch (failure) { invalidate('저장 결과를 확인하지 못했습니다. 입력은 유지됩니다. 서버 설정을 다시 불러와 결과를 확인해 주세요.'); error('저장을 확인하지 못했습니다. ' + failure.message); }
    finally { busy = false; fields.disabled = false; reload.disabled = false; update(); }
  };
}
