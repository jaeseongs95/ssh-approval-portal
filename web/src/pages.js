/** Same-origin pages share only in-memory state; administrator tokens never enter browser storage. */
export function createAdminPages({document, location, history, events=globalThis}) {
  const settings=()=>location.pathname==='/settings';
  function sync() {
    document.body.dataset.page=settings()?'settings':'approvals';
    for(const link of document.querySelectorAll('[data-page-link]')) {
      if(link.getAttribute('href')===(settings()?'/settings':'/'))link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    const editor=document.getElementById('command-policy');if(editor&&settings())editor.open=true;
    const title=document.getElementById('page-title'),korean=document.documentElement.lang.startsWith('ko');
    if(title)title.textContent=settings()?(korean?'관리자 설정':'Administrator settings'):(korean?'SSH 승인·실행':'SSH approvals and execution');
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
