const KEY = 'ssh-approval-language';
const choices = ['auto', 'ko', 'en'];
export function displayLanguage(storage, browserLanguage = 'en') {
  let choice;
  try { choice = storage?.getItem(KEY); } catch { /* browser storage can be disabled */ }
  choice = choices.includes(choice) ? choice : 'auto';
  return { choice, language: choice === 'auto' ? browserLanguage : choice };
}

/** Only this non-secret display preference is persisted; server settings are untouched. */
export function createAppearancePanel({ document, storage, location, choice, korean, reloadState = () => ({}), confirm = globalThis.confirm }) {
  const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const root = el('section'); root.id = 'appearance-settings'; root.className = 'request';
  root.append(el('h2', korean ? '화면 표시 언어' : 'Display language'));
  const label = el('label', korean ? '관리자 화면 언어' : 'Administrator display language');
  const select = el('select'); select.id = 'language-preference'; select.setAttribute('aria-label', korean ? '관리자 화면 언어' : 'Administrator display language');
  for (const [value, ko, en] of [['auto', '자동 감지', 'Automatic'], ['ko', '한국어', '한국어 (Korean)'], ['en', '영어', 'English']]) {
    const option = el('option', korean ? ko : en); option.value = value; select.append(option);
  }
  select.value = choice; label.append(select); root.append(label);
  root.append(el('p', korean ? '이 브라우저에만 저장합니다. 적용하면 새로고침되며 저장하지 않은 초안은 사라집니다. 실행 명령·출력·서버 정책·Jev 요청 언어는 바뀌지 않습니다.' : 'Saved in this browser only. Applying reloads the page and clears unsaved drafts. Commands, output, server policies and Jev request language stay unchanged.'));
  const apply = el('button', korean ? '언어 적용·새로고침' : 'Apply language and reload'); apply.type = 'button'; apply.className = 'secondary';
  const error = el('p'); error.className = 'error'; error.hidden = true; error.setAttribute('role', 'alert'); root.append(apply, error);
  apply.onclick = () => {
    if (!choices.includes(select.value)) return;
    const status = reloadState();
    if (status.blocked) {
      error.hidden = false; error.textContent = korean ? '처리 중이거나 결과 확인이 필요한 작업이 있습니다. 현재 적용 상태를 확인한 뒤 언어를 바꿔 주세요.' : 'An operation is in progress or its result needs checking. Reconcile the current state before changing language.'; return;
    }
    if (status.dirty?.length && !confirm((korean ? '저장하지 않은 초안이 사라집니다: ' : 'Unsaved drafts will be discarded: ') + status.dirty.join(', ') + (korean ? '. 언어를 바꾸고 새로고침할까요?' : '. Change language and reload?'))) return;
    try { storage.setItem(KEY, select.value); location.reload(); }
    catch { error.hidden = false; error.textContent = korean ? '언어 설정을 저장할 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.' : 'Could not save the language preference. Check browser storage settings.'; }
  };
  (document.querySelector('.policy-form') ?? document.querySelector('#environment-editor') ?? document.querySelector('.grid')).before(root);
  return root;
}
