import { uiText as tr } from './ui-text.js';
import definitions from '../../src/domain/command-risks.json' with { type: 'json' };
const names = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const unique = values => [...new Set(values)];
const definition = name => Object.hasOwn(definitions.commands, name) ? definitions.commands[name] : undefined;
const riskLabel = value => ({ low: tr('낮음'), moderate: tr('보통'), high: tr('높음') }[value] ?? tr('정보 없음'));
const membership = (name, allowed, denied) => denied.includes(name) ? tr('차단 우선') + (allowed.includes(name) ? tr(' · 자동승인 목록에도 포함') : '') : allowed.includes(name) ? tr('자동승인 목록') : tr('미등록 · 모델 평가 또는 개별 승인');

/** The existing raw inputs remain the single editable policy; this list is a view. */
export function createCommandWorkspace({ document, container, commands, denied, getOriginal, onChange, onError }) {
  const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  const button = (text, action, cls = 'secondary') => { const b = el('button', text, cls); b.type = 'button'; b.onclick = action; return b; };
  container.append(el('p', tr('왼쪽 목록에서 명령을 고르면 오른쪽에서 내용을 확인하고 수정할 수 있습니다. 변경은 검토·저장 후 적용됩니다.'), 'policy-help'));
  const stats = el('p', '', 'command-stats'); container.append(stats);
  const layout = el('div', '', 'command-workspace'); container.append(layout);
  const master = el('section', '', 'command-master'); master.setAttribute('aria-label', tr('명령 등록 목록')); layout.append(master);
  master.append(el('h4', tr('명령 등록 목록')));
  const tools = el('div', '', 'command-tools'); master.append(tools);
  const search = el('input'); search.type = 'search'; search.placeholder = tr('명령 이름이나 기능 검색'); search.maxLength = 100; search.autocomplete = 'off';
  const searchLabel = el('label', '', 'policy-field'); searchLabel.append(el('span', tr('명령 검색')), search); tools.append(searchLabel);
  const filter = el('select'); filter.setAttribute('aria-label', tr('명령 보기'));
  for (const [value, text] of [['rules', tr('이 서버의 규칙')], ['all', tr('명령 찾아 추가 · 내장 목록 포함')], ['allowed', tr('자동승인 목록')], ['denied', tr('항상 차단 목록')], ['changed', tr('변경된 명령만')], ['unknown', tr('내장 안내 없는 규칙')]]) { const o = el('option', text); o.value = value; filter.append(o); }
  const filterLabel = el('label', '', 'policy-field'); filterLabel.append(el('span', tr('명령 보기')), filter); tools.append(filterLabel);
  const discover = button(tr('명령 찾아 추가'), () => { filter.value = 'all'; limit = 12; refresh(); search.focus(); }); master.append(discover);
  const status = el('p', '', 'policy-help'); status.setAttribute('role', 'status'); master.append(status);
  const table = el('table', '', 'command-grid'), caption = el('caption', tr('명령을 선택해 상세 내용과 설정을 확인하세요.')); caption.id = 'command-grid-help'; table.append(caption);
  const head = el('thead'), headings = el('tr'); for (const text of [tr('명령'), tr('기본 위험'), tr('초안 상태')]) { const th = el('th', text); th.scope = 'col'; headings.append(th); } head.append(headings); table.append(head);
  const list = el('tbody', '', 'command-rules'); table.append(list);
  const scroll = el('div', '', 'command-table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', tr('명령 목록 스크롤')); scroll.append(table); master.append(scroll);
  const more = button(tr('명령 12개 더 보기'), () => { const previous = limit; limit += 12; refresh(); list.children[previous]?.querySelector('button')?.focus(); }); master.append(more);
  const detail = el('section', '', 'command-detail'); detail.setAttribute('aria-label', tr('선택한 명령 상세')); layout.append(detail);
  const help = el('p', tr('이름을 등록하면 옵션·인자·출력 리다이렉션도 허용합니다. 명령줄의 명령이 모두 등록돼 있으면 인자 위험도·Jev 평가 없이 실행합니다. 제외는 차단이 아니며, 미등록 명령도 모델 평가에 따라 자동 실행될 수 있습니다.'), 'policy-warning'); help.id = 'command-authority-warning'; container.append(help);
  const direct = el('details', '', 'policy-details command-direct'); direct.append(el('summary', tr('목록에 없는 명령 직접 추가'))); container.append(direct);
  const directLabel = el('label', '', 'policy-field'), entry = el('input'); entry.type = 'text'; entry.maxLength = 80; entry.autocomplete = 'off'; entry.spellcheck = false;
  directLabel.append(el('span', tr('추가할 명령 이름')), entry); direct.append(directLabel, el('p', tr('이름만 입력하세요. 예: ls. 내장 목록에 없으면 기능·위험 안내를 제공할 수 없습니다.'), 'policy-help'));
  const entryError = el('p', '', 'policy-field-error'); entryError.setAttribute('role', 'alert'); entryError.hidden = true; direct.append(entryError);
  const entryActions = el('div', '', 'command-actions'); direct.append(entryActions);
  entryActions.append(button(tr('자동승인 초안에 추가'), () => addDirect(commands)), button(tr('차단 초안에 추가'), () => addDirect(denied)));
  let limit = 12, selected;
  function addDirect(input) {
    const value = entry.value.trim(); entryError.hidden = true; entry.removeAttribute('aria-invalid');
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(value)) { entryError.textContent = tr('옵션 없이 명령 이름만 입력하세요. 예: ls -l 대신 ls'); entryError.hidden = false; entry.setAttribute('aria-invalid', 'true'); entry.focus(); return; }
    if (edit(input, value, true)) { entry.value = ''; filter.value = 'rules'; search.value = value; refresh(); entry.focus(); }
  }
  function edit(input, name, include) {
    const current = names(input.value);
    if (include && !current.includes(name) && current.length >= 128) { onError(tr('각 명령 목록은 최대 128개까지 등록할 수 있습니다.')); return false; }
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
    stats.textContent = (original ? tr('저장된 자동승인 ') + priorAllowed.length + tr('개 · 차단 ') + priorDenied.length + tr('개') : tr('저장된 정책 없음 · 기본 선택은 아직 적용되지 않은 초안')) + tr(' / 초안: 자동승인 ') + allowed.length + tr('개 · 차단 ') + blocked.length + tr('개 · 변경 ') + delta + tr('개');
    status.textContent = matches.length ? tr('일치 ') + matches.length + tr('개 · ') + Math.min(limit, matches.length) + tr('개 표시') + (filter.value === 'all' ? tr(' · 내장 목록은 서버 설치 여부를 확인하지 않습니다.') : tr(' · 저장값과 초안을 함께 표시합니다.')) : tr('일치하는 규칙이 없습니다. 명령 찾아 추가에서 내장 목록도 검색할 수 있습니다.');
    const active = document.activeElement, activeName = active.closest?.('[data-command-name]')?.dataset.commandName, activeAction = active.dataset?.commandAction, activeSelected = selected;
    const visible = matches.slice(0, limit);
    if (!visible.includes(selected)) selected = visible[0];
    list.replaceChildren();
    for (const name of visible) {
      const info = definition(name) ?? definitions.defaultRisk, row = el('tr', '', 'command-rule'); row.dataset.commandName = name; row.classList.toggle('is-selected', name === selected);
      const cell = el('td'), select = button(name, () => { selected = name; refresh(); }, 'command-select'); select.setAttribute('aria-label', name + tr(' 상세 보기')); select.setAttribute('aria-pressed', String(name === selected)); select.setAttribute('aria-controls', 'command-selected-content'); select.setAttribute('aria-describedby', caption.id); cell.append(select); row.append(cell);
      const risk = el('td'); risk.append(el('span', riskLabel(info.riskLevel), 'command-risk risk-' + info.riskLevel)); row.append(risk);
      const state = el('td', membership(name, allowed, blocked), 'command-grid-state'); if (changed(name)) state.append(el('small', tr('미저장'), 'command-delta')); row.append(state); list.append(row);
    }
    detail.replaceChildren(); detail.id = 'command-selected-content';
    if (selected) {
      const name = selected, info = definition(name) ?? definitions.defaultRisk;
      detail.append(el('p', tr('선택한 명령'), 'policy-help'));
      const head = el('div', '', 'command-rule-head'); head.append(el('h4', name), el('span', tr('기본 위험 ') + riskLabel(info.riskLevel), 'command-risk risk-' + info.riskLevel)); detail.append(head);
      const description = el('p', tr(info.description ?? (name === 'sudo' ? tr('공통 sudo 허용 설정으로 관리합니다.') : tr('내장 안내 없음'))) + ' · ' + tr(info.reason), 'policy-help'); description.id = 'command-selected-description'; detail.append(description);
      const state = el('div', '', 'command-rule-state');
      state.append(el('p', tr('마지막 저장값: ') + (original ? membership(name, priorAllowed, priorDenied) : tr('정책 없음'))), el('p', tr('저장할 초안: ') + membership(name, allowed, blocked)));
      if (changed(name)) state.append(el('strong', tr('미저장 변경'), 'command-delta')); detail.append(state, el('h5', tr('이 명령 설정 수정')));
      const actions = el('div', '', 'command-actions'); detail.append(actions);
      for (const [input, present, action, label] of [[commands, allowed.includes(name), 'allowed', allowed.includes(name) ? tr('자동승인에서 제외') : tr('자동승인에 추가')], [denied, blocked.includes(name), 'denied', blocked.includes(name) ? tr('차단 해제') : tr('항상 차단')]]) {
        const b = button(label, () => edit(input, name, !present)); b.setAttribute('aria-label', name + ' ' + label); b.setAttribute('aria-describedby', help.id + ' ' + description.id); b.dataset.commandAction = action; actions.append(b);
      }
      if (blocked.includes(name) && allowed.includes(name)) detail.append(el('p', tr('차단이 우선합니다. 차단을 해제하면 남아 있는 자동승인 등록이 다시 작동할 수 있습니다.'), 'command-consequence'));
      else if (priorAllowed.includes(name) && !allowed.includes(name)) detail.append(el('p', tr('제외 예정 · 차단한 것이 아닙니다. 모델 설정에 따라 평가 후 자동 실행될 수 있습니다.'), 'command-consequence'));
      detail.append(el('p', tr('수정은 초안에만 반영됩니다. 위의 변경 확인·저장에서 위험도를 확인하고 OK 후 저장하세요.'), 'policy-help'));
    } else detail.append(el('h4', tr('선택할 명령이 없습니다')), el('p', tr('검색어나 필터를 바꾸거나 명령 찾아 추가를 눌러주세요.'), 'policy-help'));
    more.hidden = matches.length <= limit;
    if ((activeName || activeAction) && !active.isConnected) {
      const row = [...list.children].find(row => row.dataset.commandName === activeName);
      (activeAction && activeSelected === selected && detail.querySelector('[data-command-action="' + activeAction + '"]') || row?.querySelector('button') || search).focus();
    }
  }
  search.oninput = filter.onchange = () => { limit = 12; refresh(); };
  for (const input of [search, entry]) input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); };
  return { search, filter, entry, refresh, controls: [search, filter, entry], container };
}
