import { COMMAND_MAX_BYTES, utf8WithinLimit } from '../../src/contracts/ports.mjs';
import { commandLineNames } from '../../src/domain/command-line.mjs';
import { uiText as tr } from './ui-text.js';
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function parseCommandImport(source) {
  const fail = reason => ({ complete: false, names: [], usesSudo: false, reason });
  if (typeof source !== 'string' || !source.trim()) return fail('empty');
  if (!utf8WithinLimit(source, COMMAND_MAX_BYTES)) return fail('length');
  const result = commandLineNames(source);
  if (!result.complete) return fail('unsupported');
  if (result.names.some(name => name.length > 80)) return fail('name_length');
  return { complete: true, names: result.names, usesSudo: result.usesSudo };
}

/** Local parsing only. The existing raw name field and reviewed save remain authoritative. */
export function createCommandLineImport({ document, commands, denied, onChange, onError }) {
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const button = (text, action) => { const n = el('button', tr(text), 'secondary'); n.type = 'button'; n.onclick = action; return n; };
  const panel = el('details', '', 'policy-details command-import'); panel.append(el('summary', tr('명령줄에서 이름 가져오기')));
  const label = el('label', '', 'policy-field'), source = el('textarea'); source.rows = 3; source.spellcheck = false; source.autocomplete = 'off';
  label.append(el('span', tr('분석할 명령줄')), source); panel.append(label, el('p', tr('한 줄의 명령을 붙여넣으세요. 명령은 실행하지 않고 이 브라우저에서 이름만 추출합니다.'), 'policy-help'));
  const actions = el('div', '', 'command-actions'); panel.append(actions);
  const status = el('p', '', 'policy-help'); status.setAttribute('role', 'status'); panel.append(status);
  const candidates = el('div', '', 'command-import-candidates'); candidates.tabIndex = 0; candidates.setAttribute('role', 'region'); candidates.setAttribute('aria-label', tr('명령 이름 후보')); candidates.hidden = true; panel.append(candidates);
  const selection = el('div', '', 'command-actions'); panel.append(selection);
  const warning = el('p', tr('등록하면 이 이름의 모든 옵션·인자도 허용합니다. sudo 허용 여부와 모델 기준은 바뀌지 않습니다.'), 'policy-warning'); warning.id = 'command-import-warning'; panel.append(warning);
  panel.append(el('p', tr('명령줄 원문은 이 페이지에만 두며 추출·선택만으로 서버나 모델에 보내지 않습니다.'), 'policy-help'));
  let choices = [], analyzedSource, allowedBefore, deniedBefore;
  const selected = () => choices.filter(c => c.input.checked && !c.input.disabled).map(c => c.name);
  const updateSelection = () => { add.disabled = !selected().length; all.disabled = !choices.some(c => !c.input.disabled); none.disabled = !choices.length; status.textContent = tr('선택한 이름: ') + selected().length + ' / ' + choices.length; };
  function clearResults(message = '') { analyzedSource = undefined; choices = []; candidates.replaceChildren(); candidates.hidden = true; add.disabled = all.disabled = none.disabled = true; status.textContent = message; }
  function reset() { source.value = ''; source.removeAttribute('aria-invalid'); clearResults(); panel.open = false; }
  function refresh() {
    if (analyzedSource === undefined || commands.value === allowedBefore && denied.value === deniedBefore) return;
    allowedBefore = commands.value; deniedBefore = denied.value;
    const allowed = lines(commands.value), blocked = lines(denied.value);
    for (const c of choices) {
      c.input.disabled = allowed.includes(c.name) || blocked.includes(c.name);
      if (c.input.disabled) c.input.checked = false;
      c.state.textContent = blocked.includes(c.name) ? tr('차단 목록에 있음 · 가져오기 제외') : allowed.includes(c.name) ? tr('이미 자동승인 초안에 있음') : '';
    }
    updateSelection();
  }
  function extract() {
    clearResults(); const parsed = parseCommandImport(source.value);
    if (!parsed.complete) { status.textContent = parsed.reason === 'length' ? tr('명령줄은 UTF-8 기준 32KiB(32,768바이트) 이하로 입력하세요.') : parsed.reason === 'name_length' ? tr('등록할 명령 이름은 80자 이하여야 합니다.') : tr('한 줄의 완전한 명령을 입력하세요. 동적·지원하지 않는 구문에서는 이름을 추측하지 않습니다.'); source.setAttribute('aria-invalid', 'true'); return; }
    source.removeAttribute('aria-invalid'); analyzedSource = source.value; allowedBefore = deniedBefore = undefined;
    for (const name of parsed.names) {
      const row = el('label', '', 'command-import-choice'), input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', name); input.setAttribute('aria-describedby', warning.id); input.checked = false;
      const text = el('span'), state = el('small'); text.append(el('code', name), state); row.append(input, text); candidates.append(row);
      input.onchange = updateSelection; choices.push({ name, input, state });
    }
    candidates.hidden = false; refresh();
  }
  function stage() {
    if (source.value !== analyzedSource) { clearResults(tr('원문이 바뀌었습니다. 이름을 다시 추출하세요.')); return; }
    const picked = selected(), existing = lines(commands.value), blocked = lines(denied.value);
    if (picked.some(name => blocked.includes(name))) { refresh(); return; }
    const fresh = picked.filter(name => !existing.includes(name));
    if (!fresh.length) { refresh(); return; }
    if (existing.length + fresh.length > 128) { const message = tr('각 명령 목록은 최대 128개까지 등록할 수 있습니다.'); status.textContent = message; onError(message); return; }
    commands.value += (commands.value && !commands.value.endsWith('\n') ? '\n' : '') + fresh.join('\n');
    onChange(); refresh(); status.textContent = fresh.length + tr('개 이름을 초안에 추가했습니다. 검토·저장 전에는 적용되지 않습니다.');
  }
  const extractButton = button('명령 이름 추출', extract), clear = button('입력 지우기', () => { reset(); panel.open = true; source.focus(); }); actions.append(extractButton, clear);
  const all = button('전체 선택', () => { choices.forEach(c => { if (!c.input.disabled) c.input.checked = true; }); updateSelection(); });
  const none = button('선택 해제', () => { choices.forEach(c => { c.input.checked = false; }); updateSelection(); });
  const add = button('선택한 이름을 초안에 추가', stage); add.setAttribute('aria-describedby', warning.id); selection.append(all, none, add); add.disabled = all.disabled = none.disabled = true;
  source.oninput = () => { source.removeAttribute('aria-invalid'); clearResults(tr('원문이 바뀌었습니다. 이름을 다시 추출하세요.')); };
  return { panel, source, refresh, reset, get controls() { return [source, ...choices.map(c => c.input)]; }, open(value) { reset(); panel.open = true; if (value !== undefined) { source.value = value; extract(); } source.focus(); } };
}
