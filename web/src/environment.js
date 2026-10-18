/** Secrets are write-only, drafts live only in memory, mutation POSTs are never retried. */
export function createEnvironmentPanel({ document, api, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
  const root = el('section', '', 'request environment-editor'); root.id = 'environment-editor';
  root.append(el('h2', '서버 환경설정 · ENV'), el('p', '이 서버의 ENV 파일을 편집합니다. 자동승인 정책은 위 설정에서 관리하며, ENV 저장 내용은 서비스 재시작 후 적용됩니다.', 'policy-help'));
  const message = el('p', '', 'policy-message'); message.setAttribute('role', 'status'); root.append(message);
  const load = el('button', 'ENV 불러오기', 'secondary'); load.type = 'button'; root.append(load);
  const failure = el('p', '', 'error'); failure.setAttribute('role', 'alert'); root.append(failure);
  const form = el('form'); form.hidden = true; root.append(form);
  const fields = el('fieldset', '', 'policy-fields'); form.append(fields);
  const readonly = el('p', '', 'policy-help'); form.append(readonly);
  const confirmation = el('label', '', 'policy-check'), ack = el('input'); ack.type = 'checkbox';
  confirmation.append(ack, el('span', '변경 내용을 확인했습니다. 저장은 ENV만 변경합니다. 재시작 중 연결이 잠시 끊기며 저장하지 않은 화면 초안은 사라집니다.')); form.append(confirmation);
  const actions = el('div', '', 'environment-actions'); form.append(actions);
  const save = el('button', 'ENV 저장', 'primary'); save.type = 'submit';
  const restart = el('button', '서비스 재시작', 'secondary'); restart.type = 'button'; actions.append(save, restart);
  const setup = el('details'); setup.hidden = true; setup.append(el('summary', 'ENV 편집 활성화 방법'));
  setup.append(el('p', '기능이 포함된 릴리스로 업데이트한 뒤 서버 터미널에서 한 번 실행하세요. 고정 ENV 파일과 이 서비스의 재시작만 허용하는 전용 연결입니다.', 'policy-help'),
    el('pre', 'sudo bash /var/lib/ssh-mcp/app/approval-bridge/scripts/configure-env-editor.sh'));
  root.append(setup); document.querySelector('.grid')?.before(root);
  let snapshot, busy = false, uncertain = false, generation = 0;
  const inputs = new Map();
  const changes = () => Object.fromEntries([...inputs].filter(([key, { input, remove, original, type }]) => remove.checked || (type === 'secret' ? input.value !== '' : input.value !== original))
    .map(([key, { input, remove }]) => [key, remove.checked || (input.tagName === 'SELECT' && input.value === '') ? null : input.value]));
  function lock() {
    fields.disabled = busy || uncertain; load.disabled = busy;
    save.disabled = busy || uncertain || !snapshot || !ack.checked || !Object.keys(changes()).length;
    restart.disabled = busy || uncertain || !snapshot || !ack.checked || Object.keys(changes()).length > 0;
  }
  function display(value) {
    snapshot = value; uncertain = false; setup.hidden = value.available; form.hidden = !value.available;
    if (!value.available) { message.textContent = value.message; return; }
    fields.replaceChildren(); inputs.clear(); ack.checked = false;
    for (const item of value.fields) {
      const row = el('div', '', 'environment-field'), label = el('label', '', 'policy-field');
      const input = el(item.type === 'boolean' ? 'select' : 'input'); input.id = 'env-' + item.key;
      label.append(el('span', item.label), input); row.append(label, el('small', item.key, 'policy-help'));
      if (item.type === 'boolean') for (const [v, text] of [['', '기본값 사용'], ['false', '사용 안 함'], ['true', '사용']]) { const option = el('option', text); option.value = v; input.append(option); }
      else { input.type = item.type === 'secret' ? 'password' : item.type === 'number' ? 'number' : 'text'; input.autocomplete = 'off'; input.spellcheck = false; }
      input.value = item.value ?? '';
      if (item.type === 'secret') { input.placeholder = item.configured ? '등록됨 · 교체할 때만 입력' : '미등록 · 새 키 입력'; input.setAttribute('autocomplete', 'new-password'); }
      const removeLabel = el('label', '', 'environment-unset'), remove = el('input'); remove.type = 'checkbox';
      removeLabel.append(remove, el('span', item.label + ' 설정 해제 (기본값 사용)')); row.append(removeLabel);
      remove.onchange = () => { input.disabled = remove.checked; ack.checked = false; lock(); };
      input.oninput = () => { remove.checked = false; failure.textContent = ''; ack.checked = false; lock(); };
      fields.append(row); inputs.set(item.key, { input, remove, original: item.value ?? '', type: item.type });
    }
    readonly.textContent = '터미널에서 관리하는 항목 (값 비공개): ' + value.readOnlyKeys.join(', ');
    const states = { scheduled: '재시작 예약됨', restarting: '재시작 중', healthy: '재시작 완료 · health 정상', 'rolled-back': '새 ENV로 기동 실패 · 이전 ENV 복구 완료', 'recovery-failed': '복구 실패 · 서버 터미널 확인 필요', failed: '재시작 실패', conflict: 'ENV가 별도로 변경되어 재시작 중단', 'schedule-failed': '재시작 예약 실패' };
    message.textContent = (states[value.restart?.state] ?? 'ENV를 불러왔습니다.') + (value.pendingRestart ? ' · 저장된 ENV는 재시작이 필요합니다.' : '');
    if (['scheduled', 'restarting'].includes(value.restart?.state)) uncertain = true;
    lock();
  }
  async function reload() {
    if (busy) return; const token = ++generation; busy = true; lock(); failure.textContent = '';
    try { const result = await api('/api/environment'); if (token === generation) display(result); }
    catch (error) { failure.textContent = error.message; }
    finally { busy = false; lock(); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (save.disabled) return;
    busy = true; lock(); failure.textContent = '';
    const token = generation;
    try {
      const result = await api('/api/environment', 'POST', { expectedRevision: snapshot.revision, changes: changes(), acknowledged: ack.checked });
      if (token !== generation) return;
      display(result); message.textContent = 'ENV 저장 완료 · 백업을 보관했습니다. 서비스 재시작 후 적용됩니다.';
    } catch (error) { uncertain = true; failure.textContent = error.message + ' 저장됐을 수도 있으므로 ENV 불러오기로 현재 상태부터 확인해 주세요.'; }
    finally { busy = false; lock(); }
  };
  restart.onclick = async () => {
    if (restart.disabled) return; busy = true; lock(); failure.textContent = ''; message.textContent = '재시작 요청 중…';
    let accepted; const token = generation;
    try { accepted = await api('/api/environment/restart', 'POST', { expectedRevision: snapshot.revision, acknowledged: ack.checked }); }
    catch (error) {
      if (error.message.startsWith('ENV 요청 거절: ')) {
        failure.textContent = error.message.slice('ENV 요청 거절: '.length); message.textContent = '새 재시작 요청이 접수되지 않았습니다.';
        busy = false; lock(); return;
      }
      message.textContent = '연결이 끊겼습니다. 재시작 요청 결과를 확인하는 중…';
    }
    // Only reads repeat. A missing response never triggers a second restart.
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(2000);
      if (token !== generation) { busy = false; return; }
      try {
        const result = await api('/api/environment');
        if (!result.available || ['scheduled', 'restarting'].includes(result.restart?.state)) continue;
        if (accepted?.restart?.id && result.restart?.id !== accepted.restart.id) continue;
        if (!accepted && (!result.restart?.id || result.restart.id === snapshot.restart?.id)) continue;
        display(result); busy = false; lock(); return;
      } catch { /* brief outage during restart */ }
    }
    busy = false; uncertain = true; failure.textContent = '재시작 결과를 확인하지 못했습니다. 요청을 반복하지 말고 ENV 불러오기로 상태를 확인하거나 서버 터미널을 확인해 주세요.'; lock();
  };
  ack.onchange = lock; load.onclick = reload;
  document.querySelector('#load')?.addEventListener('click', () => { if (!snapshot) reload(); });
  document.getElementById('logout')?.addEventListener('click', () => { generation++; uncertain = true; for (const { input } of inputs.values()) input.value = ''; lock(); });
  if (document.body.dataset.authMode === 'access') queueMicrotask(reload);
  lock(); return { root, reload };
}
