import { resolveLocale } from './locale.js';
/** Navigation retains DOM drafts; only non-secret location state enters history. */
export function createAdminPages({ document, location, history, events = globalThis }) {
  const route = path => ({ '/settings': 'settings', '/servers': 'settings', '/history': 'history', '/bridge': 'bridge', '/preferences': 'preferences' })[path] ?? 'approvals';
  const memories = new Map();
  let previous = route(location.pathname);
  const ko = () => resolveLocale(document?.documentElement?.lang ?? 'en').korean;
  const titles = { approvals: ['작업', 'Work'], history: ['처리 이력', 'History'], settings: ['서버 관리', 'Servers'], bridge: ['중계기 관리', 'Bridge'], preferences: ['화면 설정', 'Appearance'] };
  const notes = {
    approvals: ['승인이 필요한 요청과 진행 상황을 확인합니다. 요청의 서버를 확인하고 처리하세요.', 'Review requests and progress. Confirm each request’s target before acting.'],
    history: ['보관된 요청을 기간과 서버로 검색합니다. 실행 기록과 출력의 보관 기간은 다릅니다.', 'Search retained requests by date and target. Request records and output have separate lifetimes.'],
    settings: ['서버를 선택해 해당 서버의 정책과 명령줄 도구를 관리합니다.', 'Choose a server to manage its policy and command-line tools.'],
    bridge: ['이 중계기에 등록된 모든 서버에 영향을 주는 환경과 재시작을 관리합니다.', 'Manage environment settings and restarts affecting every target on this bridge.'],
    preferences: ['이 브라우저의 표시 환경을 설정합니다. 서버 정책은 변경하지 않습니다.', 'Change this browser’s display preferences without changing server policies.'],
  };
  function sync({ moveFocus = false, restore = false } = {}) {
    const current = route(location.pathname), changed = current !== previous;
    if (changed) memories.set(previous, { focus: document.activeElement, scroll: events.scrollY ?? 0 });
    document.body.dataset.page = current;
    for (const link of document.querySelectorAll('[data-page-link]')) {
      if (route(link.getAttribute('href')) === current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    const title = document.getElementById('page-title');
    if (title) { title.textContent = titles[current][ko() ? 0 : 1]; title.tabIndex = -1; }
    const subtitle = document.querySelector('.subtitle');
    if (subtitle) subtitle.textContent = notes[current][ko() ? 0 : 1];
    document.dispatchEvent?.(new Event('admin-scope-change'));
    if (moveFocus && changed) {
      const memory = restore ? memories.get(current) : null;
      if (memory?.focus?.isConnected && memory.focus.getClientRects().length) {
        memory.focus.focus({ preventScroll: true }); events.scrollTo?.(0, memory.scroll);
      } else { title?.focus({ preventScroll: true }); events.scrollTo?.(0, 0); }
    }
    previous = current;
  }
  function navigate(path, restore = false) {
    document.dispatchEvent?.(new Event('admin-before-scope-change'));
    if (location.pathname !== path) history.pushState(null, '', path);
    sync({ moveFocus: true, restore });
  }
  for (const link of document.querySelectorAll('[data-page-link]')) link.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(link.getAttribute('href'));
  });
  document.addEventListener?.('admin-request-return', event => {
    if (['/', '/history'].includes(event.detail?.path)) navigate(event.detail.path, true);
  });
  events.addEventListener('popstate', () => { document.dispatchEvent?.(new Event('admin-before-scope-change')); sync({ moveFocus: true, restore: true }); });
  sync();
  return { sync, settings: () => navigate('/settings') };
}
