import { uiText as tr, reviewWarning } from './ui-text.js';
import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../../src/contracts/ports.mjs';
import { createSettingsTabs } from './settings-tabs.js';
import { createCommandWorkspace } from './command-workspace.js';
import commandRisks from '../../src/domain/command-risks.json' with { type: 'json' };
const RECOMMENDED = Object.fromEntries(commandRisks.defaultCommands.map(name => [name, commandRisks.commands[name].description]));
const nameSummary = names => names.slice(0, 8).join(', ') + (names.length > 8 ? tr(' 외 ') + (names.length - 8) + tr('개') : '');
const linesOf = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const same = (a, b) => JSON.stringify(a ?? null, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(b ?? null, (_, value) => value && !Array.isArray(value) && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const CURRENT = 'ssh-command-risk-v5', BASIS = 'safety-probability-v1';
const legacy = threshold => threshold && (threshold.questionVersion !== CURRENT || threshold.basis !== BASIS);
const v4ConversionNotice = '위험 평가는 세 분류에서 두 분류(안전·위험)로 바뀌었습니다. 기존 점수 기준은 자동 승계되지 않습니다. 기존 숫자를 재사용하려면 새 기준에 대한 검증이 필요합니다.';

/** Preserve the owner policy; only explicitly edited settings become a proposal. */
export function createCommandPolicyEditor({ document, api, onNavigate = () => {}, isSignedOut = () => false }) {
  let importGeneration = 0;
  if (document.body.dataset.commandAutomation !== 'true') return;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('section', '', 'request policy-editor'); root.id = 'command-policy';
  root.append(el('h2', tr('자동승인 설정')), el('p', tr('탭을 오가며 이 서버의 하나의 초안을 수정합니다. 변경은 검토·OK·저장 후 함께 적용됩니다.'), 'policy-intro'));
  const reload = el('button', tr('다시 불러오기'), 'secondary'); reload.type = 'button'; reload.setAttribute('aria-label', tr('서버 설정 다시 불러오기'));
  const message = el('p', '', 'policy-message'); message.setAttribute('role', 'status');
  const toolbar = el('div', '', 'policy-toolbar'); toolbar.append(message, reload); root.append(toolbar);
  const draftStatus = el('p', '', 'policy-draft-status'); draftStatus.setAttribute('role','status');
  const reviewEntry = el('button', tr('변경 확인·저장'), 'secondary'); reviewEntry.type = 'button';
  const draftBar = el('div', '', 'policy-draft-bar'); draftBar.append(draftStatus, reviewEntry); root.append(draftBar);
  const loadHint = el('p', tr('초안은 이 페이지의 메모리에만 보관됩니다. 페이지를 닫거나 새로고침하면 사라집니다.'), 'policy-help'); loadHint.hidden = true; root.append(loadHint);
  const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert'); failure.hidden = true; root.append(failure);
  const reconcile = el('button', tr('현재 적용 설정 확인'), 'secondary'); reconcile.type = 'button'; reconcile.hidden = true; root.append(reconcile);
  const conflictBox = el('section', '', 'policy-warning'); conflictBox.hidden = true; root.append(conflictBox);
  const conflictText = el('p'); conflictText.setAttribute('role', 'status'); conflictBox.append(conflictText);
  const preserved = el('details', '', 'policy-details'); preserved.append(el('summary', tr('보존한 초안 보기 · 복사 가능')));
  const preservedText = el('pre'); preserved.append(preservedText); conflictBox.append(preserved);
  const latest = el('button', tr('최신 설정으로 새 초안 시작'), 'secondary'); latest.type = 'button'; conflictBox.append(latest);
  const form = el('form'); form.className = 'policy-form';
  const important = el('section', '', 'request policy-editor important-settings'); important.id = 'important-settings';
  important.append(el('h2', tr('중요 자동승인 설정 · 초안')), el('p', tr('파일 업로드·다운로드·sudo와 AI 평가를 통한 자동승인 허용 여부를 서버별로 설정합니다. 변경 후 위험도 확인·OK·저장을 거쳐야 적용됩니다.'), 'policy-help'));
  const importantFields = el('fieldset', '', 'policy-fields'); importantFields.disabled = true; important.append(importantFields);
  const importantStatus = el('p', tr('서버 설정을 불러오면 현재 허용 상태를 표시합니다.'), 'policy-message'); importantStatus.setAttribute('role','status'); important.append(importantStatus);
  const activity = el('p', '', 'policy-help'); activity.id = 'policy-activity'; activity.setAttribute('role', 'status'); activity.setAttribute('aria-atomic', 'true'); important.append(activity);
  const quickLoad = el('button', tr('현재 설정 불러오기'), 'secondary'); quickLoad.type = 'button'; important.append(quickLoad);
  form.append(important, root);
  const fields = el('fieldset', '', 'policy-fields'); fields.hidden = true; root.append(fields);
  const inactiveRules = el('section', '', 'target-rule-status'); inactiveRules.setAttribute('aria-label', tr('현재 미적용 정책')); fields.before(inactiveRules);
  const section = (number, title) => {
    const node = el('section', '', 'policy-section'); node.append(el('h3', title)); fields.append(node); return node;
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
  const one = section(1, tr('명령 고르기'));
  const target = field(importantFields, tr('정책 편집 대상'), 'select');
  const workspaceRoot = el('div'); one.append(workspaceRoot);
  const bulk = el('details', '', 'policy-details command-bulk'); bulk.append(el('summary', tr('목록 일괄 편집'))); one.append(bulk);
  bulk.append(el('p', tr('행 목록과 같은 초안입니다. 이름을 한 줄에 하나씩 입력합니다. 잘못된 입력은 위험도 확인에서 해당 위치를 알려줍니다.'), 'policy-help'));
  const commands = field(bulk, tr('자동승인할 명령'), 'textarea', '', tr('이름만 한 줄에 하나. 예: ls (-l 같은 옵션은 빼주세요.)')); commands.rows = 5; commands.spellcheck = false;
  const denied = field(bulk, tr('항상 차단할 명령'), 'textarea', '', tr('차단은 자동승인보다 우선합니다. 두 목록에 같은 이름이 있어도 차단이 우선하며, 한쪽을 바꿔도 다른 쪽은 유지됩니다.')); denied.rows = 3;
  const workspace = createCommandWorkspace({ document, container: workspaceRoot, commands, denied, getOriginal: () => original,
    onChange: () => { loadHint.hidden = false; error(''); clearFieldErrors(); invalidate(); update(); }, onError: text => error(text) });
  document.addEventListener('admin-scope-change', () => { importGeneration++; workspace.resetImport(); });
  const search = workspace.search, selectedFilter = workspace.filter;
  const examples = el('details', '', 'policy-details'); examples.append(el('summary', tr('언제 자동승인되나요?')));
  for (const text of [tr('ls와 pwd를 등록했다면: pwd && ls -la → Jev 없이 자동승인'), tr('uptime이 미등록이라면: pwd && uptime → 전체 명령줄을 Jev로 평가'), tr('금지 명령이 포함되면 자동승인보다 금지가 우선합니다.'), tr('sudo가 꺼져 있으면 sudo 요청은 개별 승인합니다. 켜도 내부 명령 등록 여부를 확인합니다.')]) examples.append(el('p', text, 'policy-help'));
  one.append(examples);
  const uploads = check(importantFields, tr('파일 자동업로드 허용'), tr('폴더 제한 없이 SSH 계정이 쓸 수 있는 경로에 새 파일을 개별 승인 없이 저장합니다. 설정·인증·자동 실행 파일 생성에도 영향을 줍니다. 덮어쓰기·sudo 전송은 계속 승인받으며 파일 내용은 Jev가 검사하지 않습니다.'));
  const downloads = check(importantFields, tr('파일 자동다운로드 허용'), tr('SSH 계정이 읽을 수 있는 일반 파일을 개별 승인 없이 준비합니다. 개인정보·인증 파일도 포함될 수 있으며 파일 내용은 Jev가 검사하지 않습니다. sudo 다운로드는 sudo 자동승인도 함께 켜야 합니다. 파일 저장은 별도로 진행합니다.'));

  const sudo = check(importantFields, tr('sudo 자동승인 허용'), tr('기본값은 꺼짐입니다. 켜면 sudo 안에서 실행하는 명령까지 사전승인 목록과 비교합니다. 하나라도 미등록이면 전체 명령줄을 Jev로 평가하며, 끄면 sudo는 매번 개별 승인을 받습니다.'));

  const execution = check(importantFields, tr('Jev·다른 모델을 통한 자동승인 허용'), tr('미등록 명령이 있으면 전체 명령줄을 평가해 저장한 기준을 충족할 때 자동 실행합니다. 정보 전송 허용과 연결된 평가 모델도 필요합니다. 끄면 미등록 명령은 개별 승인하고 사전승인 명령은 계속 자동 실행합니다.'));
  const sourceExecution = check(importantFields, tr('제출한 Python 코드 평가·실행 허용'), tr('원문과 인자를 Jev·설정된 대체 평가자에 전송하고, 저장한 기준을 통과하면 같은 코드를 실행합니다. 명령 이름 사전허용으로 건너뛰지 않습니다. 임의 코드의 권한을 이름만으로 제한할 수 없어 sudo 자동승인이 꺼져 있거나 금지 명령이 있으면 개별 승인합니다. 다른 허용 설정과 기준값은 자동으로 바꾸지 않습니다.'));
  const permissionNotes = new Map([uploads, downloads, sudo, execution, sourceExecution].map(input => { const note = el('small', '', 'policy-saved-value'); input.nextElementSibling.querySelector('strong').after(note); return [input, note]; }));

  const two = section(2, tr('Jev 도움받기'));
  const jevModel = field(two, tr('Jev 모델'), 'select', '', tr('선택한 모델로 실제 평가합니다. 바꾼 뒤 위험도 확인과 저장이 필요합니다.'));
  const modelNote = el('p', '', 'policy-help'); two.append(modelNote);
  const disclosure = check(two, tr('Jev에 정보 전송 허용'), tr('명령·작업 상황·서버 정보를 TypeSafe의 Jev로 보냅니다. 저장 전 위험도 확인부터 전송됩니다.'));
  const disclosureDetails = el('details', '', 'policy-details'); disclosureDetails.append(el('summary', tr('전송 정보 자세히 보기')), el('p', tr('등록 전에는 후보 명령셋·대상·프로필 정보를 보냅니다. 실행 판단에는 전체 명령, 작업 상황, 대상·프로필·접속대상, 명령셋과 사용자 명시적 승인 여부를 보냅니다.'), 'policy-help')); two.append(disclosureDetails);
  const transmissionNote = el('p', '', 'policy-warning'); two.append(transmissionNote);
  const scoreBox = el('div'); two.append(scoreBox);
  const probability = field(scoreBox, tr('Jev 자동승인 기준 (%)'), 'input', 'number', tr('예: 90을 입력하면 90%입니다. 모델의 낮은 위험 점수 기준이며 실제 안전을 보증하지 않습니다.'));
  probability.min = '50'; probability.max = '100'; probability.step = 'any';
  const legacyBox = el('div', '', 'policy-warning'); scoreBox.append(legacyBox);

  const advanced = el('details', '', 'policy-details policy-advanced'), advancedHeading = el('summary', tr('대체 평가·이전 기준')); advanced.append(advancedHeading); two.append(advanced);
  const advancedNote = el('p', '', 'policy-help'); advanced.append(advancedNote);
  const fallback = field(advanced, tr('Jev 평가 불가 시 대체 평가자'), 'select');
  for (const [value, label] of [['', tr('사용 안 함')], ['luna', tr('Luna · 서버 연결 별도 필요')], ['sonnet', tr('Sonnet · 서버 연결 별도 필요')]]) { const option = el('option', label); option.value = value; fallback.append(option); }
  advanced.append(el('p', tr('이 화면은 평가자의 연결 상태를 확인하지 않습니다. 평가할 수 없거나 판단이 불충분하면 사용자 승인으로 넘어갑니다.'), 'policy-help'));
  const scores = {};
  for (const provider of ['jev', 'luna', 'sonnet']) {
    const box = el('div', '', 'policy-provider'); advanced.append(box);
    const model = provider === 'jev' ? jevModel : field(box, (provider === 'luna' ? 'Luna' : 'Sonnet') + tr(' 모델'), 'select');
    const score = provider === 'jev' ? probability : field(box, provider + tr(' 자동승인 기준 (%)'), 'input', 'number');
    score.min = '50'; score.max = '100'; score.step = 'any';
    const old = provider === 'jev' ? legacyBox : el('div', '', 'policy-warning'); if (provider !== 'jev') box.append(old);
    const convert = el('button', provider + tr(' 기준을 현재 방식으로 바꾸기'), 'secondary'); convert.type = 'button';
    const conversionNotice = el('p', tr(v4ConversionNotice));
    old.append(el('p', tr('이전 점수 방식이 저장돼 있습니다. 명령만 바꾸면 그대로 보존합니다. 전환하면 자동 실행 가능 범위가 달라질 수 있습니다.')), conversionNotice, convert);
    scores[provider] = { box, model, score, old, convert, conversionNotice };
  }
  const three = section(3, tr('위험도 확인 후 저장'));
  const summary = el('div', '', 'policy-change-summary'); three.append(summary);
  const reviewButton = el('button', tr('이 설정으로 위험도 확인'), 'primary'); reviewButton.type = 'button'; three.append(reviewButton);
  three.append(el('p', tr('위험도 확인은 명령을 실행하거나 설정을 저장하지 않습니다. 정보 전송을 허용한 경우 이 확인부터 후보 명령과 서버 정보가 Jev에 전송됩니다.'), 'policy-help'));
  const feedback = el('div', '', 'policy-feedback'); feedback.tabIndex = -1; feedback.setAttribute('aria-live', 'polite'); three.append(feedback);
  const confirmation = el('div'); confirmation.hidden = true; three.append(confirmation);
  const acknowledged = check(confirmation, tr('위험도와 변경 내용을 확인했고 저장에 동의합니다 (OK)'), tr('확인 결과는 5분 동안 유효합니다. 내용을 바꾸면 다시 확인해야 합니다.')); acknowledged.disabled = true;
  const save = el('button', tr('이 서버에 저장'), 'primary'); save.type = 'submit'; save.disabled = true; confirmation.append(save);
  const tabs = createSettingsTabs({ document, container: root, panels: [[one, tr('명령 관리')], [two, tr('Jev·모델')], [three, tr('검토·저장')]] }); fields.before(root.querySelector('.settings-tabs'));
  reviewEntry.onclick = () => { tabs.select(2); three.querySelector('h3').focus(); }; three.querySelector('h3').tabIndex = -1;
  const visible = node => node.getClientRects().length > 0;
  const next = activity; next.textContent = tr('먼저 위험도를 확인해 주세요.');
  document.querySelector('.grid').before(form);

  let snapshot, original, reviewed, generation = 0, expiry, busy = false, loading = false;
  let currentTarget, conflict = false, unknownSave;
  const drafts = new Map(), archives = new Map(), removals = new Set();
  const bindingOf = id => { const b = snapshot?.bindings.find(b => b.targetId === id); return b && { targetId: b.targetId, targetRevision: b.targetRevision, profile: b.profile }; };
  const announce = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const rawInputs = () => [commands, denied, search, selectedFilter, disclosure, execution, uploads, downloads, sudo, fallback, ...Object.values(scores).flatMap(p => [p.model, p.score]), sourceExecution];
  function remember() {
    if (!currentTarget || !snapshot || conflict || unknownSave) return;
    drafts.set(currentTarget, { binding: bindingOf(currentTarget), original: structuredClone(original), revision: snapshot.revision,
      values: rawInputs().map(input => input.type === 'checkbox' ? input.checked : input.value), changed: [...changed], converted: [...converted], dirty: hasChanges() });
  }
  function preserve(draft) {
    archives.set(target.value, draft); conflictBox.hidden = false;
    preservedText.textContent = [tr('자동승인 명령:'), draft.values[0], tr('금지 명령:'), draft.values[1],
      tr('정보 전송: ') + draft.values[4] + tr(' · AI 자동승인: ') + draft.values[5],
      tr('업로드: ') + draft.values[6] + tr(' · 다운로드: ') + draft.values[7] + ' · sudo: ' + draft.values[8],
      tr('제출한 Python 코드 평가·실행 허용: ') + (draft.values.at(-1) ? tr('허용') : tr('허용 안 함')), tr('대체 평가자: ') + (draft.values[9] || tr('없음')), ...['jev', 'luna', 'sonnet'].map((p, i) => p + ': ' + draft.values[10 + i * 2] + ' · ' + draft.values[11 + i * 2] + '%')].join('\n');
  }
  function lock() {
    fields.disabled = !snapshot || busy || loading || !!unknownSave || conflict;
    importantFields.disabled = !snapshot || busy || loading || !!unknownSave;
    for (const input of [uploads, downloads, sudo, execution, sourceExecution]) input.disabled = conflict;
    reviewButton.disabled = !snapshot || busy || loading || !!unknownSave || conflict;
    reload.disabled = quickLoad.disabled = busy || loading;
    reconcile.disabled = busy || loading; latest.disabled = busy || loading || !!unknownSave;
    for (const input of inactiveRules.querySelectorAll('input')) input.disabled = busy || loading || !!unknownSave;
  }
  const changed = new Set(), converted = new Set();
  const nameOf = id => { const name = snapshot?.bindings.find(binding => binding.targetId === id)?.displayName; return name ? `${name} [${id}]` : id; };
  const activeRule = rule => snapshot?.bindings.some(binding => binding.targetId === rule.targetId && binding.enabled !== false && binding.targetRevision === rule.targetRevision && binding.profile === rule.profile);
  function showInactiveRules() {
    inactiveRules.replaceChildren();
    for (const rule of snapshot.targets.filter(rule => !activeRule(rule))) {
      const label = el('label'), remove = el('input'); remove.type = 'checkbox'; remove.checked = removals.has(rule.targetId);
      label.append(remove, el('span', nameOf(rule.targetId) + tr(' · 현재 미적용 (비활성·미등록·설정 변경). 이 정책 삭제를 초안에 포함'))); inactiveRules.append(label);
      remove.onchange = () => { if (remove.checked) removals.add(rule.targetId); else removals.delete(rule.targetId); invalidate(); update(); };
    }
  }
  function hasChanges() {
    if (!snapshot || !original && loadHint.hidden) return false;
    return !same(linesOf(commands.value), original?.commands ?? []) || !same(linesOf(denied.value), original?.deniedCommands ?? []) ||
      disclosure.checked !== (original?.externalDisclosure === true) || execution.checked !== (original?.modelExecution === true) || uploads.checked !== (original?.automaticUploads === true) ||
      sourceExecution.checked !== (original?.sourceExecutionContract === 'python-source-v1') || downloads.checked !== (original?.automaticDownloads === true) || sudo.checked !== (original?.automaticSudo === true) || (fallback.value || null) !== (original?.fallback ?? null) || changed.size > 0 || converted.size > 0;
  }
  const error = text => { failure.textContent = text; failure.hidden = !text; };
  const clearFieldErrors = () => { for (const [input, note] of fieldErrors) { note.hidden = true; note.textContent = ''; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-errormessage'); } };
  const invalid = (input, message) => {
    const note = fieldErrors.get(input); note.textContent = message; note.hidden = false;
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-errormessage', note.id); tabs.reveal(input); for (let parent = input.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; input.focus();
    const failure = Error(message); failure.field = true; throw failure;
  };
  const invalidate = (text = tr('내용이 바뀌었습니다. 위험도를 다시 확인해 주세요.')) => {
    const active = document.activeElement, restoreFocus = confirmation.contains(active) || feedback.contains(active);
    generation++; clearTimeout(expiry); reviewed = undefined; acknowledged.checked = false; acknowledged.disabled = true; save.disabled = true; confirmation.hidden = true; feedback.replaceChildren(); announce(next, text);
    if (restoreFocus) { const destination = visible(reviewButton) ? reviewButton : reviewEntry; if (visible(destination)) destination.focus(); }
  };
  function names(input, label) {
    const result = [];
    for (const [index, line] of input.value.split(/\r?\n/).entries()) {
      const name = line.trim(); if (!name) continue;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(name)) invalid(input, label + ' ' + (index + 1) + tr('번째 줄: 명령 이름만 입력하세요. 예: ls -l 대신 ls'));
      if (result.includes(name)) invalid(input, label + ' ' + (index + 1) + tr('번째 줄: ') + name + tr('이 중복됐습니다. 한 번만 남겨주세요.'));
      result.push(name);
    }
    if (result.length > 128) invalid(input, label + tr('은 최대 128개까지 등록할 수 있습니다.'));
    return result;
  }
  function update() {
    for (const [input, key] of [[uploads, 'automaticUploads'], [downloads, 'automaticDownloads'], [sudo, 'automaticSudo'], [execution, 'modelExecution']]) permissionNotes.get(input).textContent = (original ? tr('마지막 저장값: ') + (original[key] === true ? tr('허용') : tr('개별 승인')) : tr('저장된 정책 없음')) + tr(' / 초안: ') + (input.checked ? tr('허용') : tr('개별 승인'));
    permissionNotes.get(sourceExecution).textContent = (original ? tr('마지막 저장값: ') + (original.sourceExecutionContract === 'python-source-v1' ? tr('허용') : tr('개별 승인')) : tr('저장된 정책 없음')) + tr(' / 초안: ') + (sourceExecution.checked ? tr('허용') : tr('개별 승인'));
    if (snapshot) {
      const dirty = sourceExecution.checked !== (original?.sourceExecutionContract === 'python-source-v1') || uploads.checked !== (original?.automaticUploads === true) || downloads.checked !== (original?.automaticDownloads === true) || sudo.checked !== (original?.automaticSudo === true) || execution.checked !== (original?.modelExecution === true);
      announce(importantStatus, (unknownSave ? tr('저장 결과 확인 필요 · 이미 적용됐을 수 있습니다. 현재값을 확인하기 전까지 편집이 잠깁니다. 마지막 확인값: ') : '') + nameOf(target.value) + tr(' · 저장된 설정: 파일 업로드 ') + (original?.automaticUploads === true ? tr('허용') : tr('개별 승인')) + tr(' · 다운로드 ') + (original?.automaticDownloads === true ? tr('허용') : tr('개별 승인')) + ' · sudo ' + (original?.automaticSudo === true ? tr('허용') : tr('개별 승인')) + tr(' · AI 평가 자동승인 ') + (original?.modelExecution === true ? tr('허용') : tr('개별 승인')) + ' · ' + tr('제출한 Python 코드 평가·실행 허용') + ' ' + (original?.sourceExecutionContract === 'python-source-v1' ? tr('허용') : tr('개별 승인')) + (!unknownSave && dirty ? tr(' · 변경 사항은 아직 저장되지 않았습니다.') : ''));
    }
    const chosen = [...new Set(linesOf(commands.value))]; workspace.refresh();
    const draftDirty = hasChanges() || removals.size > 0;
    announce(draftStatus, unknownSave ? tr('적용 미확인 · 현재 적용 설정을 확인해 주세요.') : conflict ? tr('초안 충돌 · 편집 잠금') : busy ? tr('요청 처리 중 · 입력한 초안을 유지합니다.') : draftDirty ? tr('미저장 초안 · 변경 사항은 아직 적용되지 않았습니다.') : tr('저장된 설정과 같은 초안입니다.'));
    scoreBox.hidden = !disclosure.checked && !execution.checked && !original?.thresholds.jev;
    transmissionNote.hidden = !execution.checked || disclosure.checked;
    transmissionNote.textContent = tr('정보 전송을 허용하지 않아 Jev 자동 실행은 작동하지 않습니다. 등록 명령의 자동승인은 유지됩니다.');
    for (const [provider, inputs] of Object.entries(scores)) {
      const threshold = original?.thresholds[provider], isLegacy = legacy(threshold) && !converted.has(provider);
      inputs.box.hidden = provider !== 'jev' && !threshold && fallback.value !== provider;
      inputs.old.hidden = !isLegacy; inputs.score.disabled = isLegacy; inputs.model.disabled = isLegacy;
      inputs.conversionNotice.hidden = threshold?.questionVersion !== 'ssh-command-risk-v4';
    }
    const active = Object.keys(original?.thresholds ?? {}).join(', ') || tr('없음');
    advancedHeading.textContent = tr('대체 평가·이전 기준 · 대체 ') + (original?.fallback ?? tr('없음'));
    advancedNote.textContent = tr('저장된 점수 설정: ') + active + tr('. 수정하지 않은 값은 그대로 보존합니다. 연결 상태는 미확인입니다.');
    summary.replaceChildren(el('strong', (nameOf(target.value) || tr('서버')) + tr('에 적용할 내용')));
    if (removals.size) summary.append(el('p', tr('삭제할 정책: ') + [...removals].map(nameOf).join(', ')));
    const lines = [tr('명령 ') + commands.value.split(/\r?\n/).filter(line => line.trim()).length + tr('개 · 금지 명령 ') + denied.value.split(/\r?\n/).filter(line => line.trim()).length + tr('개'),
      tr('정보 전송 ') + (disclosure.checked ? tr('허용 (위험도 확인부터 전송)') : tr('허용 안 함')) + tr(' · Jev 기준 자동 실행 ') + (execution.checked ? tr('사용 (명령셋 밖도 포함)') : tr('사용 안 함'))];
    summary.append(el('p', tr('제출한 Python 코드 평가·실행 허용') + ': ' + (sourceExecution.checked ? tr('허용') : tr('허용 안 함')) + (sourceExecution.checked !== (original?.sourceExecutionContract === 'python-source-v1') ? tr(' · 변경 사항은 아직 저장되지 않았습니다.') : '')));
    const threshold = original?.thresholds.jev;
    if (threshold || execution.checked || changed.has('jev')) lines.push(tr('Jev 기준 ') + probability.value + '% · ' + (legacy(threshold) && !converted.has('jev') ? tr('이전 방식 보존') : tr('낮은 위험 점수 방식 · 사용자 선택 기준')));
    if (changed.has('jev') && scores.jev.model.value !== (original?.thresholds.jev?.model ?? 'jev-1.14.0')) lines.push(tr('Jev 모델 변경: ') + scores.jev.model.value);
    if (converted.size) lines.push(tr('점수 방식 전환: ') + [...converted].join(', '));
    if ([...converted].some(provider => original?.thresholds[provider]?.questionVersion === 'ssh-command-risk-v4')) lines.push(tr(v4ConversionNotice));
    if ([...converted].some(provider => Object.hasOwn(original?.thresholds[provider] ?? {}, 'minConfidence'))) lines.push(tr('기존 confidence 조건이 제거됩니다.'));
    if (fallback.value) lines.push(tr('대체 평가자 ') + fallback.value + tr(' · 연결 상태 미확인'));
    for (const line of lines) summary.append(el('p', line));
    for (const [label, value, before] of [[tr('자동승인 명령'), chosen, original?.commands ?? []], [tr('금지 명령'), linesOf(denied.value), original?.deniedCommands ?? []]]) {
      const added = value.filter(name => !before.includes(name)), removed = before.filter(name => !value.includes(name));
      summary.append(el('p', label + tr(' 추가: ') + (nameSummary(added) || tr('없음')) + tr(' · 제외: ') + (nameSummary(removed) || tr('없음'))));
      if (added.length > 8 || removed.length > 8) { const details = el('details', '', 'policy-details'); details.append(el('summary', label + tr(' 전체 변경 내역 · 추가 ') + added.length + tr('개 · 제외 ') + removed.length + tr('개')), el('p', tr('추가: ') + (added.join(', ') || tr('없음'))), el('p', tr('제외: ') + (removed.join(', ') || tr('없음')))); summary.append(details); }
    }
    for (const [label, input, prior] of [[tr('업로드'), uploads, original?.automaticUploads], [tr('다운로드'), downloads, original?.automaticDownloads], ['sudo', sudo, original?.automaticSudo], [tr('AI 평가 자동승인'), execution, original?.modelExecution], [tr('정보 전송'), disclosure, original?.externalDisclosure]]) if (input.checked !== (prior === true)) summary.append(el('p', label + tr(' 변경: ') + (prior === true ? tr('허용') : tr('허용 안 함')) + ' → ' + (input.checked ? tr('허용') : tr('허용 안 함'))));
    for (const [provider, inputs] of Object.entries(scores)) if (changed.has(provider)) summary.append(el('p', provider + tr(' 모델·기준: ') + (original?.thresholds[provider]?.model ?? tr('미설정')) + ' / ' + (original?.thresholds[provider] ? original.thresholds[provider].minLowRisk * 100 + '%' : tr('미설정')) + ' → ' + inputs.model.value + ' / ' + inputs.score.value + '%'));
    if ((fallback.value || null) !== (original?.fallback ?? null)) summary.append(el('p', tr('대체 평가자 변경: ') + (original?.fallback ?? tr('없음')) + ' → ' + (fallback.value || tr('없음'))));
    summary.append(el('p', tr('sudo 자동승인 ') + (sudo.checked ? tr('허용 · 내부 명령까지 등록 검사 · 권한 상승 포함') : tr('허용 안 함 · sudo마다 개별 승인'))));
    summary.append(el('p', tr('파일 자동업로드 ') + (uploads.checked ? tr('허용 · 폴더 제한 없이 SSH 계정이 쓸 수 있는 경로에 새 파일 저장 · 설정/인증/자동 실행 파일도 포함 · Jev 내용 검사 없음 · 덮어쓰기/sudo 제외') : tr('허용 안 함 · 전송마다 승인'))));
    summary.append(el('p', tr('파일 자동다운로드 ') + (downloads.checked ? tr('허용 · 읽을 수 있는 일반 파일 준비 · 개인정보/인증 파일 포함 가능 · Jev 내용 검사 없음 · sudo는 별도 허용 필요') : tr('허용 안 함 · 전송마다 승인'))));
  }
  function show() {
    currentTarget = target.value; conflict = false;
    original = snapshot.targets.find(rule => rule.targetId === target.value);
    changed.clear(); converted.clear(); clearFieldErrors(); loadHint.hidden = true; invalidate(tr('설정을 확인하고 위험도 확인을 눌러주세요.'));
    commands.value = (original ? original.commands : Object.keys(RECOMMENDED)).join('\n'); denied.value = (original?.deniedCommands ?? []).join('\n');
    search.value = ''; selectedFilter.value = 'rules'; workspace.entry.value = ''; workspace.resetImport(); workspace.refresh();
    disclosure.checked = original?.externalDisclosure ?? false; execution.checked = original?.modelExecution ?? false; fallback.value = original?.fallback ?? '';
    sourceExecution.checked = original?.sourceExecutionContract === 'python-source-v1';
    uploads.checked = original?.automaticUploads === true; downloads.checked = original?.automaticDownloads === true; sudo.checked = original?.automaticSudo === true;
    for (const [provider, inputs] of Object.entries(scores)) {
      const catalog = snapshot.evaluators?.[provider], saved = original?.thresholds[provider]?.model;
      const available = catalog?.models ?? (provider === 'jev' ? ['jev-1.14.0', 'jev-1.13.0'] : []);
      const chosen = saved ?? catalog?.defaultModel ?? available[0] ?? '';
      inputs.model.replaceChildren();
      for (const value of [...new Set([...available, ...(chosen ? [chosen] : [])])]) { const option = el('option', value + (!available.includes(value) ? tr(' · 저장된 선택') : '')); option.value = value; inputs.model.append(option); }
      if (!inputs.model.options.length) { const option = el('option', tr('연결된 모델 없음')); option.value = ''; inputs.model.append(option); }
      inputs.model.value = chosen;
      inputs.score.value = String((original?.thresholds[provider]?.minLowRisk ?? 0.9) * 100);
    }
    for (const option of fallback.options) if (option.value) option.disabled = !snapshot.evaluators?.[option.value]?.configured && option.value !== original?.fallback;
    modelNote.textContent = tr('모델 목록은 24시간마다 갱신합니다. 저장된 모델은 자동으로 바뀌지 않습니다.') + (snapshot.evaluators?.status === 'unavailable' ? tr(' 현재 목록 갱신에 실패해 이전 목록을 표시합니다.') : '') + tr(' 대체 평가는 서버에 연결된 모델만 선택할 수 있습니다.');
    message.textContent = original ? nameOf(target.value) + ' · ' + original.commands.length + tr('개 명령이 저장돼 있습니다.') : nameOf(target.value) + tr(' · 기본 선택을 초안에 채웠습니다. 아직 적용되지 않았습니다. 위험도 확인 후 저장하세요.');
    const draft = drafts.get(target.value);
    if (draft) {
      if (same(draft.binding, bindingOf(target.value)) && same(draft.original, original)) {
        rawInputs().forEach((input, i) => { if (input.type === 'checkbox') input.checked = draft.values[i]; else { if (input.tagName === 'SELECT' && ![...input.options].some(o => o.value === draft.values[i])) { const option = el('option', draft.values[i] + tr(' · 보존한 초안')); option.value = draft.values[i]; input.append(option); } input.value = draft.values[i]; } });
        draft.changed.forEach(p => changed.add(p)); draft.converted.forEach(p => converted.add(p)); loadHint.hidden = false;
        announce(next, tr('보존한 초안입니다. 위험도 확인과 OK를 다시 진행해 주세요.'));
      } else {
        conflict = true; preserve(draft); conflictText.textContent = tr('서버의 정책 또는 연결 정보가 바뀌었습니다. 초안은 보존했으며 자동 병합하지 않습니다. 최신 설정으로 새 초안을 시작해 주세요.');
      }
    }
    if (!conflict) { conflictBox.hidden = !archives.has(target.value); latest.hidden = true; if (archives.has(target.value)) { preserve(archives.get(target.value)); conflictText.textContent = tr('이전 초안은 참고용으로 보존됐습니다. 현재 입력에 자동 적용하지 않습니다.'); } }
    else latest.hidden = false;
    showInactiveRules(); workspace.refresh(); update(); lock();
  }
  latest.onclick = () => { drafts.delete(target.value); show(); tabs.select(0); search.focus(); };
  async function load() {
    if (loading || busy) return false;
    workspace.resetImport();
    const selectedTarget = target.value; remember();
    loading = true; invalidate(tr('서버 설정을 불러오는 중입니다.')); fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; reviewButton.disabled = true; error(''); message.textContent = tr('서버 설정을 불러오는 중입니다…');
    try {
      const fresh = await api('/api/command-policy');
      const unresolved = unknownSave; snapshot = fresh; target.replaceChildren();
      for (const binding of snapshot.bindings) { const option = el('option', nameOf(binding.targetId) + (binding.enabled === false ? tr(' · 사용 중지') : '')); option.value = binding.targetId; target.append(option); }
      for (const rule of snapshot.targets.filter(rule => !snapshot.bindings.some(binding => binding.targetId === rule.targetId))) { const option = el('option', rule.targetId + tr(' · 미등록 정책')); option.value = rule.targetId; target.append(option); }
      if (snapshot.bindings.some(b => b.targetId === selectedTarget)) target.value = selectedTarget;
      target.parentElement.hidden = target.options.length === 1; fields.hidden = false;
      if (unresolved) {
        unknownSave = undefined; reconcile.hidden = true;
        const current = snapshot.targets.find(rule => rule.targetId === unresolved.targetId), requested = unresolved.candidate.policy.targets.find(rule => rule.targetId === unresolved.targetId);
        const matches = same(current, requested) && same(unresolved.draft.binding, bindingOf(unresolved.targetId));
        if (matches) { drafts.delete(unresolved.targetId); archives.set(unresolved.targetId, unresolved.draft); }
        show(); announce(message, matches ? tr('현재 적용값은 요청한 설정과 같습니다. 이전 저장 요청의 성공 여부를 단정하지 않습니다.') : tr('현재 적용값과 요청한 설정이 다릅니다. 보존한 초안과 비교해 주세요.'));
      } else show();
      return true;
    } catch (failure) { message.textContent = tr('설정을 불러오지 못했습니다. 로그인 상태를 확인한 뒤 다시 불러오세요.'); if (!unknownSave) importantStatus.textContent = tr('현재 적용값을 확인하지 못했습니다. 마지막 확인값은 최신이 아닐 수 있습니다.'); error(tr('로그인 상태를 확인한 뒤 다시 불러오세요. ') + failure.message); return false; }
    finally { loading = false; lock(); }
  }
  reload.onclick = quickLoad.onclick = reconcile.onclick = load;
  document.querySelector('#load')?.addEventListener('click', () => { if (!snapshot) load(); });
  if (['access', 'oidc'].includes(document.body.dataset.authMode)) queueMicrotask(load);
  target.onchange = () => { remember(); error(''); show(); document.dispatchEvent(new Event('admin-scope-change')); };
  form.oninput = event => {
    if (event.target === acknowledged || event.target === target || workspace.controls.includes(event.target)) return;
    for (const [provider, inputs] of Object.entries(scores)) if ([inputs.model, inputs.score].includes(event.target)) changed.add(provider);
    loadHint.hidden = false; error(''); clearFieldErrors(); invalidate();
    if ([uploads, downloads, sudo, execution, sourceExecution].includes(event.target)) onNavigate();
    update();
  };
  for (const [provider, inputs] of Object.entries(scores)) inputs.convert.onclick = () => { converted.add(provider); changed.add(provider); invalidate(tr('점수 방식 전환을 선택했습니다. 변경 내용과 위험도를 확인해 주세요.')); update(); };
  acknowledged.onchange = () => {
    if (!reviewed || Date.now() >= reviewed.expiresAt) { invalidate(tr('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.')); return; }
    save.disabled = !acknowledged.checked; announce(next, acknowledged.checked ? tr('확인한 설정을 이 서버에 저장할 수 있습니다.') : tr('위험도와 변경 내용을 읽고 OK를 체크해 주세요.'));
  };
  function proposal() {
    if (removals.has(target.value)) return { expectedRevision: snapshot.revision, policy: { targets: structuredClone(snapshot.targets.filter(rule => !removals.has(rule.targetId))) } };
    const binding = snapshot.bindings.find(item => item.targetId === target.value);
    if (!binding || binding.enabled === false || original && !activeRule(original)) throw Error(tr('서버 연결 정보가 기존 정책과 다릅니다. 자동으로 연결을 바꾸지 않습니다. 관리자에게 확인해 주세요.'));
    const rule = original ? structuredClone(original) : { targetId: binding.targetId, targetRevision: binding.targetRevision, profile: binding.profile, commands: [], deniedCommands: [], externalDisclosure: false, modelExecution: false, fallback: null, thresholds: {} };
    Object.assign(rule, { commands: names(commands, tr('자동승인 명령')), deniedCommands: names(denied, tr('금지 명령')), externalDisclosure: disclosure.checked, modelExecution: execution.checked, fallback: fallback.value || null });
    if (uploads.checked || Object.hasOwn(rule, 'automaticUploads')) rule.automaticUploads = uploads.checked;
    if (downloads.checked || Object.hasOwn(rule, 'automaticDownloads')) rule.automaticDownloads = downloads.checked;
    if (sudo.checked || Object.hasOwn(rule, 'automaticSudo')) rule.automaticSudo = sudo.checked;
    if (sourceExecution.checked || Object.hasOwn(rule, 'sourceExecutionContract')) rule.sourceExecutionContract = sourceExecution.checked ? 'python-source-v1' : null;
    for (const [provider, inputs] of Object.entries(scores)) {
      if (!changed.has(provider) && !(provider === 'jev' && !rule.thresholds.jev && execution.checked)) continue;
      if (legacy(rule.thresholds[provider]) && !converted.has(provider)) throw Error(tr('이전 점수 방식은 명시적으로 전환해야 변경할 수 있습니다.'));
      const score = Number(inputs.score.value) / 100;
      if (!inputs.score.value || !Number.isFinite(score) || score <= 0.5 || score > 1) invalid(inputs.score, tr('50%보다 크고 100% 이하인 값을 입력해 주세요. 예: 90'));
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(inputs.model.value)) invalid(inputs.model, tr('연결된 모델을 선택해 주세요.'));
      rule.thresholds[provider] = { model: inputs.model.value, questionVersion: CURRENT, basis: BASIS, minLowRisk: score, validationRef: 'user-choice:' + Date.now() + ':' + globalThis.crypto.randomUUID() };
    }
    const policy = structuredClone({ targets: snapshot.targets.filter(rule => !removals.has(rule.targetId)) });
    const index = policy.targets.findIndex(item => item.targetId === rule.targetId);
    if (index < 0) policy.targets.push(rule); else policy.targets[index] = rule;
    return { expectedRevision: snapshot.revision, policy };
  }
  reviewButton.onclick = async () => {
    if (!snapshot || busy || loading || unknownSave || conflict) return;
    invalidate(tr('위험도를 확인할 준비를 합니다.')); error(''); clearFieldErrors(); let candidate;
    try { candidate = proposal(); } catch (failure) { if (!failure.field) error(failure.message); return; }
    const revision = generation, focusAtStart = document.activeElement; busy = true; reviewButton.disabled = true; reload.disabled = true; announce(next, tr('위험도를 확인하는 중입니다…'));
    try {
      const result = await api('/api/command-policy/review', 'POST', candidate);
      if (revision !== generation) return;
      if (Date.now() >= result.expiresAt) { invalidate(tr('확인 결과가 만료됐습니다. 위험도를 다시 확인해 주세요.')); return; }
      reviewed = { ...result, candidate };
      feedback.append(el('h4', tr('저장 전 확인해 주세요')), el('p', tr(result.notice)));
      if (!result.feedback.length) feedback.append(el('p', tr('저장된 설정과 같습니다. 새 평가 결과는 없습니다.')));
      const labels = { low_risk: tr('안전'), high_risk: tr('위험'), uncertain: tr('평가 없음') };
      for (const item of result.feedback) {
        const card = el('div', '', 'policy-risk'); card.dataset.level = item.level;
        card.append(el('strong', nameOf(item.targetId) + tr(' · 종합 위험도 ') + labels[item.level]), el('p', nameSummary(item.commands) || tr('등록할 명령 없음')));
        card.append(el('p', tr('서버의 등록 규칙과 사용 가능한 Jev 평가를 반영한 안내입니다. 파일 자동업로드나 영향이 큰 명령은 서버 규칙에서 높은 위험으로 안내합니다.')));
        if (item.assessment) {
          card.append(el('p', tr('Jev 분류: ') + labels[item.assessment.label] + tr(' · 구체적인 위험 사유는 제공되지 않았습니다.')));
          const details = el('details'); details.append(el('summary', tr('평가 상세')), el('p', tr('안전 점수 ') + (item.assessment.probabilities.low_risk * 100).toFixed(1) + tr('% · 위험 점수 ') + (item.assessment.probabilities.high_risk * 100).toFixed(1) + tr('% · 실제 안전을 보증하지 않습니다.'))); card.append(details);
        } else card.append(el('p', tr('평가가 없다는 것이 안전하다는 뜻은 아닙니다. 아래 경고를 읽어주세요.')));
        if (item.commandRisks?.length) { const definitions = el('details'); definitions.append(el('summary',tr('명령별 기본 위험도 · 등록 안내'))); for (const risk of item.commandRisks) definitions.append(el('p', risk.name + ' · ' + ({low:tr('낮음'),moderate:tr('보통'),high:tr('높음'),unknown:tr('정보 없음')}[risk.riskLevel] ?? tr('정보 없음')) + ' · ' + tr(risk.reason))); card.append(definitions); }
        card.append(el('p', reviewWarning(item.warning))); feedback.append(card);
      }
      confirmation.hidden = false; acknowledged.disabled = false; announce(next, tr('위험도와 변경 내용을 읽고 OK를 체크해 주세요.'));
      expiry = setTimeout(() => invalidate(tr('확인 결과가 만료됐습니다. 입력은 유지됩니다. 위험도를 다시 확인해 주세요.')), result.expiresAt - Date.now());
      if (document.activeElement === focusAtStart && visible(feedback)) feedback.focus();
    } catch (failure) { if (revision === generation) { error(tr('위험도를 확인하지 못했습니다. 입력은 유지됩니다. ') + failure.message); invalidate(tr('위험도를 확인하지 못했습니다. 입력은 유지됩니다. 다시 확인해 주세요.')); } }
    finally { busy = false; lock(); }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!reviewed || !acknowledged.checked || busy || unknownSave || conflict) return;
    if (Date.now() >= reviewed.expiresAt) { invalidate(tr('확인 결과가 만료됐습니다. 위험도를 다시 확인해 주세요.')); return; }
    remember(); const checked = reviewed, draft = drafts.get(target.value), submittedTarget = target.value; clearTimeout(expiry); busy = true; fields.disabled = importantFields.disabled = true; reload.disabled = quickLoad.disabled = true; save.disabled = true; error('');
    try {
      const result = await api('/api/command-policy', 'POST', { ...checked.candidate, reviewToken: checked.reviewToken, acknowledged: true });
      snapshot = { ...result, bindings: snapshot.bindings, evaluators: snapshot.evaluators }; drafts.delete(submittedTarget); removals.clear(); const server = nameOf(target.value); show();
      message.textContent = server + tr('에 명령 ') + (original?.commands.length ?? 0) + tr('개를 저장했습니다.'); announce(next, tr('저장 완료. 이후 요청부터 이 설정을 적용합니다.'));
    } catch (failure) { unknownSave = { candidate: checked.candidate, targetId: submittedTarget, draft }; reconcile.hidden = false; preserve(draft); latest.hidden = true; conflictText.textContent = tr('저장 요청에 보낸 초안입니다. 현재 적용값은 아직 확인하지 못했습니다.'); invalidate(tr('저장 결과를 확인하지 못했습니다. 이미 적용됐을 수 있습니다. 현재 적용 설정 확인을 눌러주세요.')); error(tr('저장을 확인하지 못했습니다. ') + failure.message); }
    finally { busy = false; update(); lock(); }
  };
  return {
    clearCommandImport() { importGeneration++; workspace.resetImport(); },
    async importCommandNames(input) {
      const request = { targetId: input?.targetId, targetRevision: input?.targetRevision, profile: input?.profile, command: input?.command };
      if (isSignedOut()) return false;
      if (!['targetId', 'targetRevision', 'profile', 'command'].every(key => typeof request[key] === 'string' && request[key].length) || !utf8WithinLimit(request.command, COMMAND_MAX_BYTES)) { error(tr('등록할 일반 명령 이력을 선택해 주세요.')); return false; }
      onNavigate(); const token = ++importGeneration;
      if (busy || loading || unknownSave) { error(tr('처리 중이거나 저장 결과 확인이 필요해 명령줄을 가져올 수 없습니다.')); return false; }
      if (!await load()) return false;
      if (token !== importGeneration || isSignedOut() || !snapshot || document.body.dataset.page !== 'settings') return false;
      const binding = snapshot.bindings.find(b => b.targetId === request.targetId), rule = snapshot.targets.find(r => r.targetId === request.targetId);
      if (!binding || binding.enabled === false || binding.targetRevision !== request.targetRevision || binding.profile !== request.profile || rule && !activeRule(rule)) { error(tr('이력의 연결 정보가 현재 정책 대상과 다릅니다. 현재 설정을 확인해 주세요.')); return false; }
      remember(); target.value = request.targetId; error(''); show(); document.dispatchEvent(new Event('admin-scope-change'));
      if (conflict || unknownSave) return false;
      tabs.select(0); const bulk = workspace.container.closest('.command-bulk'); if (bulk) bulk.open = true;
      workspace.importLine(request.command); return true;
    },
    async openTarget(id) {
      onNavigate();
      if (busy || loading || unknownSave) { error(tr('처리 중이거나 저장 결과 확인이 필요해 정책 대상을 바꿀 수 없습니다.')); return; }
      if (!snapshot) await load();
      if (!snapshot || ![...target.options].some(option => option.value === id)) { error(tr('등록된 정책 대상을 선택해 주세요.')); return; }
      remember(); target.value = id; error(''); show(); document.dispatchEvent(new Event('admin-scope-change')); target.focus();
    },
    reloadState() {
      remember();
      return { blocked: busy || loading || !!unknownSave, dirty: [...new Set([...drafts].filter(([, draft]) => draft.dirty).map(([id]) => nameOf(id)).concat([...archives.keys()].map(nameOf), [...removals].map(nameOf)))] };
    },
  };
}
