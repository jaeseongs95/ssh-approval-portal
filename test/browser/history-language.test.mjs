import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixtureServer } from './fixture-server.mjs';

async function fixture(run, { locale='ko-KR', width=1280, height=900, mobile=false, initialize }={}) {
  const server=await fixtureServer(process.env.UI_SOURCE_ROOT??fileURLToPath(new URL('../../',import.meta.url)));let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.SOLID_CHROMIUM_PATH?{executablePath:process.env.SOLID_CHROMIUM_PATH}:{})});
    const context=await browser.newContext({locale,viewport:{width,height},hasTouch:mobile,isMobile:mobile});
    await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
    if(initialize)await context.addInitScript(initialize);
    const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await run(page,server,context);assert.deepEqual(errors,[]);
  } finally {await browser?.close();await server.close();}
}
const job=(id,state='completed')=>({id,kind:'command',state,command:'printf "한글 원문 <script>" '+id,target:'fixture',createdAt:1000,expiresAt:2000000000000,
  result:{structuredContent:{output:{id:'b'.repeat(48),state:'ready',bytes:21}}}});

test('history has an independent route and keeps filters, expanded DOM and loaded output across tabs/back/forward',async()=>fixture(async(page,server)=>{
  server.state.multiTarget=true;server.state.jobs=[{...job('history-alpha'),targetId:'alpha'},{...job('history-beta'),targetId:'beta'},job('waiting','pending')];
  await page.goto(server.origin+'/');await page.locator('#jobs .request').waitFor();assert.equal(await page.locator('#history-panel').isVisible(),false);
  await page.locator('[href="/history"]').focus();await page.keyboard.press('Enter');await page.waitForURL('**/history');
  assert.equal(await page.locator('.work-column').isVisible(),false);await page.selectOption('#target-filter','alpha');
  await page.getByRole('searchbox',{name:'이력 검색'}).fill('history-alpha');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  const record=page.locator('#history details');await record.locator('summary').click();await page.getByRole('button',{name:'출력 보기',exact:true}).click();
  await page.getByText('EXPLICIT_WEB_SENTINEL',{exact:true}).waitFor();await record.evaluate(node=>window.savedHistory=node);
  await page.locator('[href="/settings"]').click();await page.goBack();
  assert.equal(await page.getByRole('searchbox',{name:'이력 검색'}).inputValue(),'history-alpha');assert.equal(await page.locator('#target-filter').inputValue(),'alpha');
  assert.equal(await page.getByLabel('처리 상태',{exact:true}).inputValue(),'completed');assert.equal(await record.evaluate(node=>node===window.savedHistory&&node.open),true);
  await page.goForward();await page.locator('[href="/history"]').click();assert.equal(await page.getByText('EXPLICIT_WEB_SENTINEL',{exact:true}).isVisible(),true);assert.equal(server.state.outputReads,1);
  assert.equal(await page.locator('#history .command').textContent(),server.state.jobs[0].command);assert.equal(await page.locator('script').count(),1);
}));

test('filtered history pagination uses the filtered anchor and direct entry survives refresh on mobile',async()=>fixture(async(page,server)=>{
  server.state.jobs=Array.from({length:46},(_,i)=>({...job('item-'+String(i).padStart(2,'0'),i%2?'completed':'failed'),createdAt:1000-i}));
  await page.goto(server.origin+'/history');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  await page.getByRole('searchbox',{name:'이력 검색'}).fill('item-');await page.locator('#history-pagination').getByRole('button',{name:'다음',exact:true}).click();
  assert.equal(await page.locator('#history details').first().getAttribute('data-request-id'),'item-41');
  await page.locator('[data-page-link][href="/"]').click();await page.locator('[href="/history"]').click();assert.equal(await page.locator('#history details').first().getAttribute('data-request-id'),'item-41');
  await page.reload();assert.equal(await page.locator('[href="/history"]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('#history-panel').isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/history-mobile.png',fullPage:true});
},{width:390}));

test('explicit language overrides browser language, persists across reload/navigation and stores no token or draft',async()=>fixture(async(page,server)=>{
  server.state.jobs=[job('원문')];await page.goto(server.origin+'/settings');assert.equal(await page.locator('html').getAttribute('lang'),'ko');
  await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(await page.getByLabel('Administrator display language',{exact:true}).inputValue(),'en');
  assert.equal(await page.getByRole('navigation',{name:'Management navigation',exact:true}).count(),1);
  await page.getByRole('link',{name:'Approval history',exact:true}).click();await page.locator('#history details summary').click();
  assert.equal(await page.locator('#history .command').textContent(),server.state.jobs[0].command);
  await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'en'});assert.equal(server.state.requests.some(x=>x.method==='POST'),false);
}));

test('Korean selection works in English browser, and automatic restores browser detection',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/settings');await page.getByLabel('Administrator display language',{exact:true}).selectOption('ko');await page.getByRole('button',{name:'Apply language and reload'}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='ko');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('auto');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');
},{locale:'en-US'}));

test('disabled storage shows an accessible error',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/settings');assert.equal(await page.locator('html').getAttribute('lang'),'ko');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.getByText('언어 설정을 저장할 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.',{exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'ko');
},{initialize:()=>Object.defineProperty(window,'localStorage',{get(){throw Error('disabled');}})}));

test('English settings translate dynamic command controls, input errors and ENV labels without changing server values',async()=>fixture(async(page,server)=>{
  server.state.commandAutomation=true;const posts=[];
  await page.route('**/api/command-policy',route=>{posts.push(route.request().method());return route.fulfill({json:{revision:1,bindings:[{targetId:'default',targetRevision:'v1',profile:'fixture',displayName:'자동승인 설정'}],targets:[],evaluators:{jev:{models:['jev-1.14.0'],defaultModel:'jev-1.14.0'}}}});});
  await page.route('**/api/environment',route=>route.fulfill({json:{available:true,revision:'a'.repeat(64),fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'자동승인 설정'}],readOnlyKeys:[],restart:{state:'idle'}}}));
  await page.goto(server.origin+'/settings');await page.getByRole('tab',{name:'Commands',exact:true}).waitFor();
  await page.getByText('Registered commands',{exact:true}).waitFor();await page.locator('.command-direct summary').click();await page.getByLabel('Command name to add',{exact:true}).fill('ls -l');await page.getByRole('button',{name:'Add to preapproval draft',exact:true}).click();
  await page.getByText('Enter a command name without options, e.g. ls instead of ls -l.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Bridge display name',{exact:true}).inputValue(),'자동승인 설정');assert.equal(await page.locator('#important-settings select').textContent(),'자동승인 설정');assert.deepEqual([...new Set(posts)],['GET']);
  if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/settings-english.png',fullPage:true});
},{locale:'en-US'}));


for(const viewport of [
  {name:'desktop',width:1440,height:900},{name:'laptop',width:1280,height:800},
  {name:'compact-desktop',width:1024,height:768},{name:'tablet-portrait',width:768,height:1024},
  {name:'phone-portrait',width:390,height:844,mobile:true},{name:'small-phone',width:320,height:740,mobile:true},
  {name:'phone-landscape',width:844,height:390,mobile:true}
])test('responsive history and language workflow '+viewport.name,async()=>fixture(async(page,server)=>{
  server.state.commandAutomation=true;server.state.jobs=[...Array.from({length:26},(_,i)=>job('matrix-'+i,i%2?'failed':'completed')),...Array.from({length:24},(_,i)=>job('waiting-'+i,'pending')),...Array.from({length:24},(_,i)=>job('executing-'+i,'running'))];
  const longOutput='EXPLICIT_WEB_SENTINEL\n'+Array.from({length:150},(_,i)=>'출력 '+i+' raw output').join('\n');let outputReads=0;await page.route('**/api/outputs/*',route=>{outputReads++;return route.fulfill({json:{text:longOutput,offsetBytes:0,nextOffset:Buffer.byteLength(longOutput),totalBytes:Buffer.byteLength(longOutput),eof:true}});});
  server.state.jobs[0].command+='\n'+Array.from({length:80},(_,i)=>'command line '+i).join('\n');
  await page.route('**/api/command-policy',route=>route.fulfill({json:{revision:1,bindings:[{targetId:'default',targetRevision:'v1',profile:'fixture',displayName:'대상 원문'}],targets:[],evaluators:{jev:{models:['jev-1.14.0'],defaultModel:'jev-1.14.0'}}}}));
  await page.route('**/api/environment',route=>route.fulfill({json:{available:true,revision:'a'.repeat(64),fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'서버 원문'}],readOnlyKeys:[],restart:{state:'idle'}}}));
  const geometry=[];
  const fits=async stage=>{const g=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,nav:Array.from(document.querySelectorAll('.admin-nav a'),n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};})}));g.draft=await page.locator('.policy-draft-bar').evaluate(n=>{const r=n.getBoundingClientRect(),s=n.querySelector('.policy-draft-status').getBoundingClientRect(),b=n.querySelector('button').getBoundingClientRect();return {visible:r.width>0,barWidth:r.width,statusWidth:s.width,statusHeight:s.height,buttonWithin:b.right<=r.right&&b.left>=r.left,flexDirection:getComputedStyle(n).flexDirection};});geometry.push({stage,...g});if(g.draft.visible&&g.draft.statusWidth<Math.min(160,g.draft.barWidth-32)&&process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/layout-fail-'+viewport.name+'-'+stage+'.png',fullPage:true});if(g.draft.visible){assert.ok(g.draft.statusWidth>=Math.min(160,g.draft.barWidth-32),JSON.stringify({stage,...g.draft}));assert.ok(g.draft.statusHeight<200,JSON.stringify({stage,...g.draft}));assert.ok(g.draft.buttonWithin);}assert.ok(g.documentWidth<=g.width,JSON.stringify({stage,...g}));assert.ok(g.nav.every(n=>n.left>=0&&n.right<=g.width&&n.height>=40));};
  await page.goto(server.origin+'/history');await page.getByRole('searchbox',{name:'이력 검색'}).fill('matrix-');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  assert.equal(await page.locator('#history details').count(),13);await page.locator('#history details summary').first().click();await page.getByRole('button',{name:'출력 보기',exact:true}).first().click();await page.locator('#history .output').first().waitFor();await fits('history-ko');
  const scrollEnd=async(selector)=>{const n=page.locator(selector).first();await n.hover();const original=await n.textContent();await page.mouse.wheel(0,100000);await page.waitForFunction(selector=>{const n=document.querySelector(selector);return n.scrollHeight>n.clientHeight&&n.scrollTop+n.clientHeight>=n.scrollHeight-2;},selector);assert.equal(await n.textContent(),original);geometry.push({stage:'scroll-end-'+selector,...await n.evaluate(n=>({top:n.scrollTop,height:n.clientHeight,total:n.scrollHeight}))});};
  await scrollEnd('#history .command');await scrollEnd('#history .output');assert.equal(outputReads,1);
  await page.locator('.intro').hover();await page.mouse.wheel(0,100000);await page.waitForFunction(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-3);geometry.push({stage:'page-bottom',reached:true});
  await page.getByRole('link',{name:'설정',exact:true}).click();await page.getByRole('tab',{name:'명령 관리',exact:true}).waitFor();await fits('settings-ko');
  await page.getByRole('button',{name:'명령 찾아 추가',exact:true}).click();const detailBeforeScroll=await page.locator('.command-detail').textContent();await scrollEnd('.command-table-scroll');const sticky=await page.locator('.command-table-scroll').evaluate(n=>({top:n.getBoundingClientRect().top,head:n.querySelector('th').getBoundingClientRect().top}));assert.ok(Math.abs(sticky.top-sticky.head)<3,JSON.stringify(sticky));assert.equal(await page.locator('.command-detail').textContent(),detailBeforeScroll);await page.getByLabel('명령 검색',{exact:true}).fill('pwd');await page.getByRole('button',{name:'pwd 상세 보기',exact:true}).click();
  assert.match(await page.locator('.command-detail').textContent(),/pwd/);await fits('command-detail-ko');
  await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');
  await page.getByRole('tab',{name:'Commands',exact:true}).waitFor();assert.equal(await page.getByLabel('Bridge display name',{exact:true}).inputValue(),'서버 원문');await fits('settings-en');if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/settings-'+viewport.name+'.png',fullPage:true});
  for(const tabName of ['Jev and models','Review and save','Commands']){await page.getByRole('tab',{name:tabName,exact:true}).click();await fits('tab-'+tabName);}
  await page.getByRole('link',{name:'Approval history',exact:true}).click();await page.getByRole('searchbox',{name:'Search history'}).fill('matrix-2');await page.getByLabel('Request status',{exact:true}).selectOption('failed');
  assert.equal(await page.locator('#history details').count(),3);await fits('history-en');await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');await fits('history-en-reload');
  await page.getByRole('link',{name:'Approvals',exact:true}).click();await scrollEnd('#jobs');await scrollEnd('#running');await fits('approval-queues');await page.getByRole('link',{name:'Approval history',exact:true}).click();
  assert.equal(server.state.requests.some(r=>r.method==='POST'),false);assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'en'});
  if(process.env.UI_SCREENSHOTS){const fs=await import('node:fs/promises');await fs.writeFile(process.env.UI_SCREENSHOTS+'/matrix-'+viewport.name+'.json',JSON.stringify(geometry,null,2));await page.screenshot({path:process.env.UI_SCREENSHOTS+'/matrix-'+viewport.name+'.png',fullPage:true});}
},viewport));


test('invalid saved language safely uses browser detection without changing other storage',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/settings');assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.getByLabel('Administrator display language',{exact:true}).inputValue(),'auto');
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'unsupported','unrelated-preference':'keep'});assert.equal(server.state.requests.some(r=>r.method==='POST'),false);
},{locale:'en-US',initialize:()=>{localStorage.setItem('ssh-approval-language','unsupported');localStorage.setItem('unrelated-preference','keep');}}));
