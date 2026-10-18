import definitions from '../../src/domain/command-risks.json' with { type: 'json' };
const names = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const unique = values => [...new Set(values)];
const definition = name => Object.hasOwn(definitions.commands, name) ? definitions.commands[name] : undefined;
const riskLabel = value => ({ low: '낮음', moderate: '보통', high: '높음' }[value] ?? '정보 없음');
const membership = (name, allowed, denied) => denied.includes(name) ? '차단 우선' + (allowed.includes(name) ? ' · 자동승인 목록에도 포함' : '') : allowed.includes(name) ? '자동승인 목록' : '미등록 · 모델 평가 또는 개별 승인';

/** The existing raw inputs remain the single editable policy; this list is a view. */
export function createCommandWorkspace({ document, container, commands, denied, getOriginal, onChange, onError }) {
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const button = (text, action, cls = 'secondary') => { const b = el('button', text, cls); b.type = 'button'; b.onclick = action; return b; };
  container.append(el('p', '등록된 규칙을 살펴보고, 필요한 명령을 초안에 추가하세요. 저장하기 전에는 서버 설정이 바뀌지 않습니다.', 'policy-help'));
  const stats = el('p', '', 'command-stats'); container.append(stats);
  const tools = el('div', '', 'command-tools'); container.append(tools);
  const search = el('input'); search.type = 'search'; search.placeholder = '명령 이름이나 기능 검색'; search.maxLength = 100; search.autocomplete = 'off';
  const searchLabel = el('label', '', 'policy-field'); searchLabel.append(el('span', '명령 검색'), search); tools.append(searchLabel);
  const filter = el('select'); filter.setAttribute('aria-label', '명령 보기');
  for (const [value, text] of [['rules', '이 서버의 규칙'], ['all', '명령 찾아 추가 · 내장 목록 포함'], ['allowed', '자동승인 목록'], ['denied', '항상 차단 목록'], ['changed', '변경된 명령만'], ['unknown', '내장 안내 없는 규칙']]) { const o = el('option', text); o.value = value; filter.append(o); }
  const filterLabel = el('label', '', 'policy-field'); filterLabel.append(el('span', '명령 보기'), filter); tools.append(filterLabel);
  const discover = button('명령 찾아 추가', () => { filter.value = 'all'; limit = 12; refresh(); search.focus(); }); container.append(discover);
  const help = el('p', '이름을 등록하면 옵션·인자·출력 리다이렉션도 허용합니다. 명령줄의 명령이 모두 등록돼 있으면 인자 위험도·Jev 평가 없이 실행합니다. 제외는 차단이 아니며, 미등록 명령도 모델 평가에 따라 자동 실행될 수 있습니다.', 'policy-warning'); help.id = 'command-authority-warning'; container.append(help);
  const status = el('p', '', 'policy-help'); status.setAttribute('role', 'status'); container.append(status);
  const list = el('ul', '', 'command-rules'); list.setAttribute('aria-label', '명령 규칙'); container.append(list);
  const more = button('명령 12개 더 보기', () => { const previous = limit; limit += 12; refresh(); list.children[previous]?.querySelector('button')?.focus(); }); container.append(more);
  const direct = el('details', '', 'policy-details command-direct'); direct.append(el('summary', '목록에 없는 명령 직접 추가')); container.append(direct);
  const directLabel = el('label', '', 'policy-field'), entry = el('input'); entry.type = 'text'; entry.maxLength = 80; entry.autocomplete = 'off'; entry.spellcheck = false;
  directLabel.append(el('span', '추가할 명령 이름'), entry); direct.append(directLabel, el('p', '이름만 입력하세요. 예: ls. 내장 목록에 없으면 기능·위험 안내를 제공할 수 없습니다.', 'policy-help'));
  const entryError = el('p', '', 'policy-field-error'); entryError.setAttribute('role', 'alert'); entryError.hidden = true; direct.append(entryError);
  const entryActions = el('div', '', 'command-actions'); direct.append(entryActions);
  entryActions.append(button('자동승인 초안에 추가', () => addDirect(commands)), button('차단 초안에 추가', () => addDirect(denied)));
  let limit = 12;
  function addDirect(input) {
    const value = entry.value.trim(); entryError.hidden = true; entry.removeAttribute('aria-invalid');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(value)) { entryError.textContent = '옵션 없이 명령 이름만 입력하세요. 예: ls -l 대신 ls'; entryError.hidden = false; entry.setAttribute('aria-invalid', 'true'); entry.focus(); return; }
    if (edit(input, value, true)) { entry.value = ''; filter.value = 'rules'; search.value = value; refresh(); entry.focus(); }
  }
  function edit(input, name, include) {
    const current = names(input.value);
    if (include && !current.includes(name) && current.length >= 128) { onError('각 명령 목록은 최대 128개까지 등록할 수 있습니다.'); return false; }
    input.value = include ? (current.includes(name) ? input.value : input.value + (input.value && !input.value.endsWith('\n') ? '\n' : '') + name) : input.value.split(/\r?\n/).filter(line => line.trim() !== name).join('\n');
    onChange(); return true;
  }
  function refresh() {
    const original = getOriginal(), allowed = names(commands.value), blocked = names(denied.value), priorAllowed = original?.commands ?? [], priorDenied = original?.deniedCommands ?? [];
    const rules = unique([...priorAllowed, ...priorDenied, ...allowed, ...blocked]);
    const catalog = filter.value === 'all' ? Object.keys(definitions.commands) : [];
    const query = search.value.trim().toLowerCase(), terms = query.split(/\s+/).filter(Boolean);
    const changed = name => allowed.includes(name) !== priorAllowed.includes(name) || blocked.includes(name) !== priorDenied.includes(name);
    const matches = unique([...rules, ...catalog]).filter(name => {
      const info = definition(name);
      return (filter.value !== 'allowed' || allowed.includes(name) || priorAllowed.includes(name)) && (filter.value !== 'denied' || blocked.includes(name) || priorDenied.includes(name)) &&
        (filter.value !== 'changed' || changed(name)) && (filter.value !== 'unknown' || !info) && terms.every(term => [name, info?.description, info?.category].join(' ').toLowerCase().includes(term));
    }).sort((a, b) => Number(b.toLowerCase() === query) - Number(a.toLowerCase() === query) || a.localeCompare(b));
    const delta = rules.filter(changed).length;
    stats.textContent = (original ? '저장된 자동승인 ' + priorAllowed.length + '개 · 차단 ' + priorDenied.length + '개' : '저장된 정책 없음 · 기본 선택은 아직 적용되지 않은 초안') + ' / 초안: 자동승인 ' + allowed.length + '개 · 차단 ' + blocked.length + '개 · 변경 ' + delta + '개';
    status.textContent = matches.length ? '일치 ' + matches.length + '개 · ' + Math.min(limit, matches.length) + '개 표시' + (filter.value === 'all' ? ' · 내장 목록은 서버 설치 여부를 확인하지 않습니다.' : ' · 저장값과 초안을 함께 표시합니다.') : '일치하는 규칙이 없습니다. 명령 찾아 추가에서 내장 목록도 검색할 수 있습니다.';
    const active = document.activeElement, activeName = active.closest?.('[data-command-name]')?.dataset.commandName, activeAction = active.dataset?.commandAction, activeIndex = [...list.children].findIndex(row => row.contains(active));
    list.replaceChildren();
    for (const name of matches.slice(0, limit)) {
      const info = definition(name) ?? definitions.defaultRisk, row = el('li', '', 'command-rule'); row.dataset.commandName = name;
      const head = el('div', '', 'command-rule-head'); head.append(el('strong', name), el('span', '기본 위험 ' + riskLabel(info.riskLevel), 'command-risk')); row.append(head);
      const description = el('p', (info.description ?? (name === 'sudo' ? '공통 sudo 허용 설정으로 관리합니다.' : '내장 안내 없음')) + ' · ' + info.reason, 'policy-help'); description.id = 'command-description-' + list.children.length; row.append(description);
      const state = el('div', '', 'command-rule-state');
      state.append(el('p', '마지막 저장값: ' + (original ? membership(name, priorAllowed, priorDenied) : '정책 없음')), el('p', '저장할 초안: ' + membership(name, allowed, blocked)));
      if (changed(name)) state.append(el('strong', '미저장 변경', 'command-delta')); row.append(state);
      const actions = el('div', '', 'command-actions'); row.append(actions);
      for (const [input, present, action, label] of [[commands, allowed.includes(name), 'allowed', allowed.includes(name) ? '자동승인에서 제외' : '자동승인에 추가'], [denied, blocked.includes(name), 'denied', blocked.includes(name) ? '차단 해제' : '항상 차단']]) {
        const b = button(label, () => edit(input, name, !present)); b.setAttribute('aria-label', name + ' ' + label); b.setAttribute('aria-describedby', help.id + ' ' + description.id); b.dataset.commandAction = action; actions.append(b);
      }
      if (blocked.includes(name) && allowed.includes(name)) row.append(el('p', '차단이 우선합니다. 차단을 해제하면 남아 있는 자동승인 등록이 다시 작동할 수 있습니다.', 'command-consequence'));
      else if (priorAllowed.includes(name) && !allowed.includes(name)) row.append(el('p', '제외 예정 · 차단한 것이 아닙니다. 모델 설정에 따라 평가 후 자동 실행될 수 있습니다.', 'command-consequence'));
      list.append(row);
    }
    more.hidden = matches.length <= limit;
    if (activeName && !active.isConnected) {
      const row = [...list.children].find(row => row.dataset.commandName === activeName);
      (row?.querySelector('[data-command-action="' + activeAction + '"]') ?? list.children[Math.max(0, Math.min(activeIndex, list.children.length - 1))]?.querySelector('button') ?? search).focus();
    }
  }
  search.oninput = filter.onchange = () => { limit = 12; refresh(); };
  for (const input of [search, entry]) input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
  return { search, filter, entry, refresh, controls: [search, filter, entry], container };
}
