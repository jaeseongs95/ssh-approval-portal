import { messageCatalog, translate, resolveLocale } from './locale.js';

export const desktopCatalogs = messageCatalog({
  '서버 데스크톱': 'Server desktop', '데스크톱 열기': 'Open desktop', '화면 새로고침': 'Refresh screen', '데스크톱 닫기': 'Close desktop',
  '선택한 서버의 실제 OS 화면을 표시합니다. 화면을 클릭한 뒤 키보드로 조작하세요.': 'View the selected server’s actual OS screen. Click the screen, then use the keyboard.',
  '데스크톱은 서버 설정과 권한 안에서만 열립니다. 열려 있는 동안 서버 선택을 유지합니다.': 'The desktop opens within server configuration and permissions. Its target remains selected until closed.',
  '데스크톱이 열려 있지 않습니다.': 'No desktop is open.', '서버 화면': 'Server screen', '전송할 텍스트': 'Text to send', '텍스트 전송': 'Send text',
  '데스크톱 대상 {target} · 화면 {width} × {height}': 'Desktop target {target} · screen {width} × {height}',
  '입력 결과를 확인하지 못했습니다. 입력을 반복하지 말고 화면을 새로고침하세요.': 'Input outcome unconfirmed. Refresh the screen without repeating the input.',
  '서버 연결 정보를 확인할 수 없습니다.': 'The target binding could not be verified.',
  '화면을 읽을 수 없습니다.': 'The screen could not be loaded.',
  '데스크톱 연결 결과를 확인하지 못했습니다. 자동으로 다시 열지 않습니다.': 'Desktop connection outcome unconfirmed. It will not reopen automatically.',
  '연결을 닫았습니다. 서버 계정에서 로그아웃하지 않았습니다.': 'Connection closed. The server account was not logged out.',
  '데스크톱 정리 결과를 확인하세요: ': 'Check desktop cleanup: ',
  '실행 중인 데스크톱': 'Open desktop',
  '연결 상태 확인': 'Check connection state',
  'Windows 계정 인증이 필요합니다. 로그인 화면을 확인하고 아래 일회성 입력을 사용하세요.': 'Windows account authentication is required. Inspect the login screen and use the one-time input below.',
  '현재 화면과 대상 서버를 확인했고 Windows 로그인 입력란을 직접 선택했습니다.': 'I checked the current screen and target server, and selected the Windows login field.',
  '일회성 인증 입력': 'One-time authentication input',
  '현재 선택한 로그인 입력란으로 전송': 'Send to the selected login field',
  'Ctrl+Alt+Delete 요청': 'Request Ctrl+Alt+Delete',
  '입력값은 저장하지 않습니다. 먼저 화면에서 로그인 입력란을 선택하세요. 전송 후 화면을 확인하고 Enter를 직접 누르세요. SAS 요청의 실제 동작은 서버 서비스와 정책에 따라 달라집니다.': 'The value is not stored. Select the login field on screen first. After sending, inspect the screen and press Enter yourself. SAS behavior depends on the server service and policy.',
  '화면 연결됨 · GUI 세션과 입력 준비 상태는 아직 확인되지 않았습니다.': 'Screen transport connected · GUI session binding and input readiness are not verified.',
  '데스크톱 준비가 확인되었습니다.': 'Desktop readiness has been verified.',
  '서버의 GUI 상태를 확인하지 못했습니다. 연결 상태를 다시 확인하세요.': 'The server GUI state could not be verified. Check the connection state again.',
  'RDP 창을 계속 열어 둘 필요는 없습니다. Windows 계정 인증과 화면 준비 상태는 별도로 확인합니다.': 'An RDP window does not need to stay open. Windows account authentication and screen readiness are checked separately.',
});

const namedKeys = { Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, Backspace: 0xff08, Delete: 0xffff, Insert: 0xff63,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['F' + (index + 1), 0xffbe + index])) };

/** Complete key/click gestures avoid leaving held OS input after a browser disconnect. */
export function desktopKeyActions(event) {
  if (event.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return [];
  const point = [...event.key].length === 1 ? event.key.codePointAt(0) : undefined;
  const keysym = namedKeys[event.key] ?? (point === undefined ? undefined : point <= 255 ? point : 0x01000000 + point);
  if (!keysym) return [];
  const modifiers = [[event.ctrlKey, 0xffe3], [event.altKey, 0xffe9], [event.shiftKey, 0xffe1], [event.metaKey, 0xffeb]].filter(([enabled]) => enabled).map(([, key]) => key);
  return [...modifiers.map(keysym => ({ type: 'key', keysym, down: true })), { type: 'key', keysym, down: true }, { type: 'key', keysym, down: false }, ...modifiers.reverse().map(keysym => ({ type: 'key', keysym, down: false }))];
}

export function desktopPointerActions(event, bounds, width, height) {
  if (bounds.width <= 0 || bounds.height <= 0 || ![0, 1, 2].includes(event.button)) return [];
  const x = Math.max(0, Math.min(width - 1, Math.floor((event.clientX - bounds.left) * width / bounds.width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor((event.clientY - bounds.top) * height / bounds.height)));
  return [{ type: 'pointer', x, y, buttons: [1, 2, 4][event.button] }, { type: 'pointer', x, y, buttons: 0 }];
}

export function createDesktopPanel({ document, api, getTarget, isSignedOut = () => false, timers = globalThis, randomKey = () => globalThis.crypto.randomUUID(), onStateChange = () => {} }) {
  const { locale } = resolveLocale(document.documentElement.lang);
  const number = new Intl.NumberFormat(locale), t = (key, values) => translate(desktopCatalogs, locale, key, values);
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const root = el('section'); root.id = 'desktop-viewer'; root.className = 'request';
  root.append(el('h2', t('서버 데스크톱')), el('p', t('선택한 서버의 실제 OS 화면을 표시합니다. 화면을 클릭한 뒤 키보드로 조작하세요.')), el('p', t('데스크톱은 서버 설정과 권한 안에서만 열립니다. 열려 있는 동안 서버 선택을 유지합니다.')));
  const status = el('p', t('데스크톱이 열려 있지 않습니다.')); status.setAttribute('role', 'status');
  const error = el('p'); error.className = 'error'; error.setAttribute('role', 'alert');
  const readinessStatus = el('p'); readinessStatus.id = 'desktop-readiness'; readinessStatus.setAttribute('role', 'status');
  const controls = el('div'); controls.className = 'actions';
  const open = el('button', t('데스크톱 열기')), refresh = el('button', t('화면 새로고침')), close = el('button', t('데스크톱 닫기'));
  for (const button of [open, refresh, close]) { button.type = 'button'; button.className = 'secondary'; controls.append(button); }
  const checkState = el('button', t('연결 상태 확인')); checkState.type = 'button'; checkState.className = 'secondary'; controls.append(checkState);
  const image = el('img'); image.alt = t('서버 화면'); image.tabIndex = 0; image.hidden = true;
  image.style.cssText = 'display:block;max-width:100%;height:auto;border:1px solid var(--line);touch-action:manipulation';
  const label = el('label', t('전송할 텍스트')), text = el('textarea'); text.maxLength = 2048; text.rows = 2; label.append(text);
  const send = el('button', t('텍스트 전송')); send.type = 'button'; send.className = 'secondary';
  const auth = el('fieldset'); auth.id = 'desktop-authentication';
  const authLabel = el('label', t('일회성 인증 입력')), credential = el('input');
  credential.type = 'password'; credential.maxLength = 2048; credential.autocomplete = 'off'; credential.setAttribute('autocomplete', 'off'); authLabel.append(credential);
  const confirmationLabel = el('label', t('현재 화면과 대상 서버를 확인했고 Windows 로그인 입력란을 직접 선택했습니다.'));
  const confirmation = el('input'); confirmation.type = 'checkbox'; confirmationLabel.append(confirmation);
  const authSend = el('button', t('현재 선택한 로그인 입력란으로 전송')), sas = el('button', t('Ctrl+Alt+Delete 요청'));
  authSend.type = sas.type = 'button';
  auth.append(el('legend', t('일회성 인증 입력')), el('p', t('입력값은 저장하지 않습니다. 먼저 화면에서 로그인 입력란을 선택하세요. 전송 후 화면을 확인하고 Enter를 직접 누르세요. SAS 요청의 실제 동작은 서버 서비스와 정책에 따라 달라집니다.')), confirmationLabel, authLabel, authSend, sas);
  root.append(status, error, readinessStatus, controls, image, label, send, auth); document.getElementById('server-workspace')?.append(root);
  let session, frame, nextSequence, busy = false, uncertain = false, openingUncertain = false, generation = 0, pendingFrame, observedTarget = getTarget();
  let closingRequested = false, closeFlight;
  const idleWaiters = [];
  const settled = () => { busy = false; lock(); for (const resolve of idleWaiters.splice(0)) resolve(); };
  const body = () => ({ sessionId: session.sessionId, epoch: session.epoch });
  function showReadiness(value) {
    if (value) session.readiness = value;
    const state = session?.readiness;
    const labels = { auth_required: 'Windows 계정 인증이 필요합니다. 로그인 화면을 확인하고 아래 일회성 입력을 사용하세요.',
      transport_ready: '화면 연결됨 · GUI 세션과 입력 준비 상태는 아직 확인되지 않았습니다.', desktop_ready: '데스크톱 준비가 확인되었습니다.',
      capture_unavailable: '서버의 GUI 상태를 확인하지 못했습니다. 연결 상태를 다시 확인하세요.' };
    readinessStatus.textContent = state ? t(labels[state.state] ?? labels.capture_unavailable)
      + (state.ownerOnly ? ' ' + t('RDP 창을 계속 열어 둘 필요는 없습니다. Windows 계정 인증과 화면 준비 상태는 별도로 확인합니다.') : '') : '';
  }
  function lock() {
    root.hidden = document.body.dataset.page !== 'settings';
    open.disabled = busy || !!session || openingUncertain || isSignedOut() || !getTarget();
    refresh.disabled = busy || !session || isSignedOut(); close.disabled = busy || !session || isSignedOut();
    checkState.disabled = busy || !session || isSignedOut();
    const blocked = busy || !session || !frame || pendingFrame || uncertain || isSignedOut();
    image.setAttribute('aria-disabled', String(!!blocked)); text.disabled = !!blocked; send.disabled = !!blocked || !text.value;
    auth.hidden = !session; credential.disabled = !!blocked;
    confirmation.disabled = !!blocked; authSend.disabled = !!blocked || !confirmation.checked || !credential.value;
    sas.disabled = !!blocked || !confirmation.checked;
    onStateChange();
  }
  async function observe() {
    if (busy || closingRequested || !session || isSignedOut()) return;
    busy = true; lock(); const token = generation;
    try {
      const value = await api('/api/desktop/observe', 'POST', body());
      if (token !== generation) return;
      showReadiness(value.readiness);
      if (value.mimeType !== 'image/png' || !Number.isSafeInteger(value.width) || value.width < 1 || !Number.isSafeInteger(value.height) || value.height < 1 || !Number.isSafeInteger(value.nextInputSequence) || value.nextInputSequence < 1 || typeof value.frameId !== 'string' || typeof value.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(value.data)) throw Error(t('화면을 읽을 수 없습니다.'));
      pendingFrame = value; frame = undefined; image.hidden = false; image.src = 'data:image/png;base64,' + value.data;
    } catch (failure) { if (token === generation) { uncertain = true; error.textContent = failure.message; } }
    finally { settled(); }
  }
  image.onload = () => {
    if (!pendingFrame || !session) return;
    frame = pendingFrame; pendingFrame = undefined; nextSequence = frame.nextInputSequence; uncertain = false; error.textContent = '';
    status.textContent = t('데스크톱 대상 {target} · 화면 {width} × {height}', { target: session.targetId, width: number.format(frame.width), height: number.format(frame.height) }); lock();
  };
  image.onerror = () => { frame = pendingFrame = undefined; uncertain = true; error.textContent = t('화면을 읽을 수 없습니다.'); lock(); };
  async function input(actions) {
    if (busy || closingRequested || !session || !frame || pendingFrame || uncertain || !actions.length || isSignedOut()) return false;
    const request = { ...body(), frameId: frame.frameId, geometryRevision: frame.geometryRevision, sequence: nextSequence, requestKey: randomKey(), actions };
    const token = generation; busy = true; lock();
    try {
      const receipt = await api('/api/desktop/input', 'POST', request);
      if (token !== generation) return false;
      if (receipt.sessionId !== session.sessionId || receipt.sequence !== request.sequence || receipt.requestKey !== request.requestKey || receipt.state !== 'sent') throw Error('DESKTOP_INVALID_RECEIPT');
      nextSequence++; return true;
    } catch (failure) { if (token === generation) { uncertain = true; error.textContent = failure.message + ' ' + t('입력 결과를 확인하지 못했습니다. 입력을 반복하지 말고 화면을 새로고침하세요.'); } return false; }
    finally { settled(); }
  }
  async function authenticate(action) {
    if (busy || !session || !frame || uncertain || pendingFrame || !confirmation.checked || isSignedOut()) return;
    const request = { ...body(), frameId: frame.frameId, geometryRevision: frame.geometryRevision, sequence: nextSequence,
      requestKey: randomKey(), confirmed: true, action, ...(action === 'credential' ? { value: credential.value } : {}) };
    credential.value = ''; confirmation.checked = false;
    const token = generation; busy = true; lock();
    try {
      const receipt = await api('/api/desktop/authenticate', 'POST', request);
      if (token !== generation) return;
      if (receipt.sessionId !== session.sessionId || receipt.sequence !== request.sequence || receipt.requestKey !== request.requestKey || receipt.state !== 'sent') throw Error('DESKTOP_INVALID_RECEIPT');
      nextSequence++;
    } catch (failure) { if (token === generation) { uncertain = true; error.textContent = failure.message + ' ' + t('입력 결과를 확인하지 못했습니다. 입력을 반복하지 말고 화면을 새로고침하세요.'); } }
    finally { request.value = undefined; settled(); }
    if (!uncertain && token === generation) await observe();
  }
  credential.oninput = confirmation.onchange = lock;
  authSend.onclick = () => { if (!authSend.disabled) return authenticate('credential'); };
  sas.onclick = () => { if (!sas.disabled) return authenticate('sas'); };
  open.onclick = async () => {
    if (open.disabled) return;
    busy = true; lock(); const targetId = getTarget(), token = generation; let submitted = false;
    try {
      const listed = await api('/api/targets'), target = listed.targets?.find(item => item.id === targetId);
      if (!target || !/^[a-f0-9]{64}$/.test(target.revision)) throw Error(t('서버 연결 정보를 확인할 수 없습니다.'));
      if (token !== generation || targetId !== getTarget() || isSignedOut()) return;
      submitted = true;
      const value = await api('/api/desktop/open', 'POST', { target: targetId, expectedTargetRevision: target.revision });
      if (token !== generation) return;
      session = value; error.textContent = ''; text.value = '';
      showReadiness(value.readiness);
    } catch (failure) { if (token === generation) { openingUncertain = submitted && !(failure.status >= 400 && failure.status < 500); error.textContent = failure.message + (openingUncertain ? ' ' + t('데스크톱 연결 결과를 확인하지 못했습니다. 자동으로 다시 열지 않습니다.') : ''); } }
    finally { settled(); }
    if (session && !closingRequested) await observe();
  };
  async function closeSession() {
    credential.value = ''; confirmation.checked = false;
    closingRequested = true;
    if (closeFlight) return closeFlight;
    closeFlight = (async () => {
      while (busy) await new Promise(resolve => idleWaiters.push(resolve));
      if (!session || isSignedOut()) return;
      busy = true; lock(); const token = generation;
      try {
        const result = await api('/api/desktop/close', 'POST', body());
        if (token !== generation) return;
        if (!result.closed) throw Error('DESKTOP_CLOSE_UNCONFIRMED');
        session = frame = pendingFrame = undefined; uncertain = false; image.hidden = true; image.removeAttribute('src'); text.value = '';
        readinessStatus.textContent = ''; credential.value = ''; confirmation.checked = false;
        status.textContent = t('연결을 닫았습니다. 서버 계정에서 로그아웃하지 않았습니다.');
        error.textContent = result.cleanupError ? t('데스크톱 정리 결과를 확인하세요: ') + result.cleanupError : '';
      } catch (failure) { if (token === generation) { uncertain = true; error.textContent = failure.message; } }
      finally { settled(); }
    })();
    try { return await closeFlight; }
    finally { closeFlight = undefined; closingRequested = false; lock(); }
  }
  refresh.onclick = observe; close.onclick = closeSession; text.oninput = lock;
  checkState.onclick = async () => {
    if (checkState.disabled || closingRequested) return;
    busy = true; lock(); const token = generation;
    try {
      const value = await api('/api/desktop/status', 'POST', body());
      if (token !== generation) return;
      if (session.readiness?.generation !== value.readiness?.generation) { frame = pendingFrame = undefined; image.hidden = true; image.removeAttribute('src'); }
      showReadiness(value.readiness); error.textContent = '';
    } catch (failure) { if (token === generation) { uncertain = true; error.textContent = failure.message; } }
    finally { settled(); }
  };
  send.onclick = async () => { if (!send.disabled && await input([{ type: 'text', text: text.value }])) text.value = ''; lock(); };
  image.oncontextmenu = event => event.preventDefault();
  image.onpointerup = event => { image.focus(); void input(desktopPointerActions(event, image.getBoundingClientRect(), frame?.width ?? 0, frame?.height ?? 0)); };
  image.onkeydown = event => { if (event.key === 'Tab') return; const actions = desktopKeyActions(event); if (actions.length) { event.preventDefault(); void input(actions); } };
  // Pause background capture while an owner prepares a private one-time input.
  const polling = timers.setInterval(() => { if (!document.hidden && document.body.dataset.page === 'settings' && !credential.value && !confirmation.checked && !uncertain && !pendingFrame) void observe(); }, 2000);
  document.addEventListener('admin-scope-change', () => { lock(); if (document.body.dataset.page !== 'settings') void closeSession(); });
  document.getElementById('logout')?.addEventListener('click', () => { generation++; timers.clearInterval(polling); session = frame = pendingFrame = undefined; image.hidden = true; image.removeAttribute('src'); text.value = ''; credential.value = ''; confirmation.checked = false; readinessStatus.textContent = ''; lock(); });
  lock();
  return { root, close: closeSession, syncTarget() { if (observedTarget !== getTarget()) { observedTarget = getTarget(); openingUncertain = false; } lock(); }, reloadState: () => ({ blocked: busy || !!session || openingUncertain, dirty: text.value ? [t('실행 중인 데스크톱')] : [] }) };
}
