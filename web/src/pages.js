/** Navigation state is in memory. CLI restoration stores public request hints only; administrator tokens never enter browser storage. */
export function createAdminPages({document, location, history, events=globalThis}) {
  const page=()=>['/settings','/history'].includes(location.pathname)?location.pathname.slice(1):'approvals';
  const settings=()=>page()==='settings';
  function sync() {
    document.body.dataset.page=page();
    for(const link of document.querySelectorAll('[data-page-link]')) {
      if(link.getAttribute('href')===(page()==='approvals'?'/':'/'+page()))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    const title=document.getElementById('page-title'),korean=document.documentElement.lang.startsWith('ko');
    if(title)title.textContent=settings()?(korean?'관리자 설정':'Administrator settings'):page()==='history'?(korean?'승인 이력':'Approval history'):(korean?'SSH 승인·실행':'SSH approvals and execution');
    const subtitle=document.querySelector('.subtitle');
    if(subtitle)subtitle.textContent=settings()?(korean?'정책 편집 대상을 아래에서 선택합니다. ENV와 재시작은 중계기 전체에 적용됩니다.':'Choose the policy target below. ENV and restart affect the entire bridge.'):page()==='history'?(korean?'보관 중인 처리 이력을 검색하고 결과를 확인합니다. 전체 누적 기록은 아닙니다.':'Search retained request history and inspect results. This is not an all-time archive.'):(korean?'명령과 파일 전송 내용을 확인하세요. 승인한 요청은 한 번만 실행됩니다.':'Review commands and file transfers. Each approved request runs once.');
    document.title=document.title.replace(/ · (설정|Settings)$/,'')+(settings()?(korean?' · 설정':' · Settings'):'');
    document.dispatchEvent?.(new Event('admin-scope-change'));
  }
  function navigate(path) {if(location.pathname!==path)history.pushState(null,'',path);sync();}
  for(const link of document.querySelectorAll('[data-page-link]'))link.addEventListener('click',event=>{
    if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();navigate(link.getAttribute('href'));
  });
  events.addEventListener('popstate',sync);sync();
  return {sync,settings:()=>navigate('/settings')};
}
