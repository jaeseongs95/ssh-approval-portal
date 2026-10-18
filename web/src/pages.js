/** Same-origin pages share only in-memory state; administrator tokens never enter browser storage. */
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
    if(subtitle)subtitle.textContent=settings()?(korean?'서버의 자동승인 범위를 관리합니다. 변경은 검토·OK·저장 후 함께 적용됩니다.':'Manage automation for this server. Changes apply together after review, explicit OK and save.'):page()==='history'?(korean?'보관 중인 처리 이력을 검색하고 결과를 확인합니다. 전체 누적 기록은 아닙니다.':'Search retained request history and inspect results. This is not an all-time archive.'):(korean?'명령과 파일 전송 내용을 확인하세요. 승인한 요청은 한 번만 실행됩니다.':'Review commands and file transfers. Each approved request runs once.');
    document.title=document.title.replace(/ · (설정|Settings)$/,'')+(settings()?(korean?' · 설정':' · Settings'):'');
  }
  function navigate(path) {if(location.pathname!==path)history.pushState(null,'',path);sync();}
  for(const link of document.querySelectorAll('[data-page-link]'))link.addEventListener('click',event=>{
    if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();navigate(link.getAttribute('href'));
  });
  events.addEventListener('popstate',sync);sync();
  return {sync,settings:()=>navigate('/settings')};
}
