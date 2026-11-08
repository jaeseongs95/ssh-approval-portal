import { createWebI18n } from './i18n.js';
import { messageCatalog, translate } from './locale.js';
import { uiText } from './ui-text.js';

export const capacityCatalogs = messageCatalog({
  '중계기 실행 한도': 'Bridge execution limits', '서버 실행 한도': 'Server execution limits',
  '실행 대기 한도': 'Queue capacity', '동시 실행 한도': 'Maximum concurrency',
  '전역값 상속': 'Inherit global setting', '한도 불러오기': 'Load limits', '한도 저장': 'Save limits',
  '전역 한도는 등록된 모든 서버에 적용됩니다.': 'Global limits apply across all registered servers.',
  '빈 값은 전역 한도를 상속합니다. 서버 한도와 전역 한도가 함께 적용됩니다.': 'An empty value inherits the global limit. Both target and global limits apply.',
  '한도를 줄여도 실행 중인 작업을 강제 종료하지 않습니다.': 'Reducing limits does not terminate running work.',
  '가용 CPU {cpus}개 · 설치 기본값: 대기 {queue}, 동시 실행 {running}': 'Available CPUs: {cpus} · installation defaults: queue {queue}, concurrent {running}',
  '현재 실행 대기 {queued}개 · 실행 중 {running}개': 'Currently queued: {queued} · running: {running}',
  '실효 한도: 대기 {queue}개 · 동시 실행 {running}개': 'Effective limits: queue {queue} · concurrent {running}',
  '설정할 서버를 선택해 주세요.': 'Choose a server to configure.',
  '한도를 불러왔습니다.': 'Limits loaded.', '한도를 저장했습니다.': 'Limits saved.',
  '저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 한도를 불러와 확인하세요.': 'Save outcome unconfirmed. Load the limits before saving again.',
  '양의 안전한 정수를 입력하세요.': 'Enter a positive safe integer.',
  '실행 한도 초안': 'Execution limit draft',
});

export function parseCapacity(value, inherit = false) {
  if (inherit && value.trim() === '') return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw Error('양의 안전한 정수를 입력하세요.');
  return Number(value);
}

/** One POST per save; an uncertain result must be reconciled with a fresh GET. */
export function createCapacityPanel({ document, api, i18n = createWebI18n(document.documentElement.lang), getTarget = () => '', isSignedOut = () => false }) {
  const { locale, formatNumber } = i18n;
  const t = (key, values) => translate(capacityCatalogs, locale, key, values);
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  let snapshot, busy = false, uncertain = false, generation = 0;
  const drafts = new Map();
  function make(scope, title, note) {
    const root = el('section'); root.className = 'request capacity-panel'; root.id = 'capacity-' + scope;
    root.append(el('h2', t(title)), el('p', t(note)), el('p', t('한도를 줄여도 실행 중인 작업을 강제 종료하지 않습니다.')));
    const defaults = el('p'), status = el('p'), effective = el('p'), message = el('p');
    status.setAttribute('role', 'status'); message.setAttribute('role', 'status');
    const error = el('p'); error.className = 'error'; error.setAttribute('role', 'alert');
    const load = el('button', t('한도 불러오기')); load.type = 'button'; load.className = 'secondary';
    const form = el('form'), fields = el('fieldset'); fields.className = 'policy-fields';
    const inputs = {};
    for (const [key, label] of [['queueCapacity', '실행 대기 한도'], ['maxConcurrency', '동시 실행 한도']]) {
      const row = el('label', t(label)), input = el('input'); row.className = 'policy-field'; input.type = 'number'; input.min = '1'; input.max = String(Number.MAX_SAFE_INTEGER); input.step = '1';
      input.id = 'capacity-' + scope + '-' + key; input.required = scope === 'global';
      if (scope === 'target') input.placeholder = t('전역값 상속');
      input.oninput = () => { drafts.set(keyFor(scope), Object.fromEntries(Object.entries(inputs).map(([name, field]) => [name, field.value]))); error.textContent = ''; lock(); };
      row.append(input); fields.append(row); inputs[key] = input;
    }
    const save = el('button', t('한도 저장')); save.type = 'submit'; save.className = 'primary';
    form.append(fields, save); root.append(defaults, status, effective, message, error, load, form);
    load.onclick = reload; form.onsubmit = event => { event.preventDefault(); return saveScope(scope); };
    return { root, defaults, status, effective, message, error, load, form, fields, inputs, save };
  }
  const global = make('global', '중계기 실행 한도', '전역 한도는 등록된 모든 서버에 적용됩니다.');
  const target = make('target', '서버 실행 한도', '빈 값은 전역 한도를 상속합니다. 서버 한도와 전역 한도가 함께 적용됩니다.');
  (document.getElementById('environment-editor') ?? document.getElementById('work-layout'))?.before(global.root);
  (document.getElementById('server-panels') ?? document.getElementById('server-workspace'))?.append(target.root);
  const keyFor = scope => scope === 'global' ? 'global' : 'target:' + getTarget();
  const selected = () => snapshot?.targets?.find(item => item.id === getTarget());
  function lock() {
    for (const [scope, panel] of [['global', global], ['target', target]]) {
      const ready = !!snapshot && (scope === 'global' || !!selected());
      panel.fields.disabled = busy || uncertain || !ready;
      panel.save.disabled = busy || uncertain || !ready || !drafts.has(keyFor(scope));
      panel.load.disabled = busy || isSignedOut();
    }
  }
  function render() {
    global.root.hidden = document.body.dataset.page !== 'bridge';
    const ws = document.getElementById('server-workspace');
    const activeTab = ws?.getAttribute?.('data-server-tab') ?? ws?.['data-server-tab'];
    target.root.hidden = document.body.dataset.page !== 'settings' || Boolean(activeTab && activeTab !== 'capacity');
    for (const [scope, panel, item] of [['global', global, snapshot?.settings], ['target', target, selected()]]) {
      const draft = drafts.get(keyFor(scope));
      for (const [name, input] of Object.entries(panel.inputs)) input.value = draft?.[name] ?? (item?.[name] === null || item?.[name] === undefined ? '' : String(item[name]));
      const state = scope === 'global' ? snapshot?.status : item?.status;
      panel.status.textContent = state ? t('현재 실행 대기 {queued}개 · 실행 중 {running}개', { queued: formatNumber(state.queued), running: formatNumber(state.running) }) : '';
      const limits = scope === 'global' ? snapshot?.settings : item?.effective;
      panel.effective.textContent = limits ? t('실효 한도: 대기 {queue}개 · 동시 실행 {running}개', { queue: formatNumber(limits.queueCapacity), running: formatNumber(limits.maxConcurrency) }) : scope === 'target' ? t('설정할 서버를 선택해 주세요.') : '';
    }
    global.defaults.textContent = snapshot ? t('가용 CPU {cpus}개 · 설치 기본값: 대기 {queue}, 동시 실행 {running}', { cpus: formatNumber(snapshot.availableCpus), queue: formatNumber(snapshot.availableCpus * 10), running: formatNumber(snapshot.availableCpus) }) : '';
    lock();
  }
  async function reload() {
    if (busy || isSignedOut()) return;
    const token = generation; busy = true; lock();
    try {
      const value = await api('/api/capacity');
      if (token !== generation || isSignedOut()) return;
      snapshot = value; uncertain = false;
      // Explicit reconciliation discards the submitted draft; unrelated target drafts survive.
      global.message.textContent = target.message.textContent = t('한도를 불러왔습니다.');
      global.error.textContent = target.error.textContent = '';
    } catch (error) { if (token === generation) global.error.textContent = target.error.textContent = uiText(t(error.message), document); }
    finally { busy = false; render(); }
  }
  async function saveScope(scope) {
    const panel = scope === 'global' ? global : target, key = keyFor(scope), targetId = getTarget();
    if (panel.save.disabled || isSignedOut()) return;
    let values;
    try { values = Object.fromEntries(Object.entries(panel.inputs).map(([name, input]) => [name, parseCapacity(input.value, scope === 'target')])); }
    catch (error) { panel.error.textContent = t(error.message); return; }
    const token = generation; busy = true; lock(); panel.error.textContent = '';
    try {
      const value = await api('/api/capacity', 'POST', { expectedRevision: snapshot.revision, ...(scope === 'global' ? { settings: values } : { targets: [{ id: targetId, ...values }] }) });
      if (token !== generation || isSignedOut()) return;
      snapshot = value; drafts.delete(key); panel.message.textContent = t('한도를 저장했습니다.');
    } catch (error) {
      if (token === generation) { uncertain = true; drafts.delete(key); panel.error.textContent = uiText(t(error.message), document) + ' ' + t('저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 한도를 불러와 확인하세요.'); }
    } finally { busy = false; render(); }
  }
  document.addEventListener('admin-scope-change', render);
  document.getElementById('logout')?.addEventListener('click', () => { generation++; uncertain = true; snapshot = undefined; drafts.clear(); render(); });
  document.getElementById('load')?.addEventListener('click', () => { if (!snapshot) reload(); });
  render();
  if (['access', 'oidc'].includes(document.body.dataset.authMode)) queueMicrotask(reload);
  return { global, target, reload, syncTarget: render, reloadState: () => ({ blocked: busy || uncertain, dirty: drafts.size ? [t('실행 한도 초안')] : [] }) };
}
