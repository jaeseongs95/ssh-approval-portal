import test from 'node:test';
import { openRequest, historyReady, navigate, selectServer } from './admin-ui.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {launchBrowser,browserName} from './browser.mjs';
import { fixtureServer } from './fixture-server.mjs';

async function fixture(run, { locale='ko-KR', width=1280, height=900, mobile=false, initialize, timezoneId }={}) {
  const server=await fixtureServer(process.env.UI_SOURCE_ROOT??fileURLToPath(new URL('../../',import.meta.url)));let browser;
  try {
    browser=await launchBrowser();
    const context=await browser.newContext({locale,...(timezoneId?{timezoneId}:{}),viewport:{width,height},hasTouch:mobile,...(browserName==='chromium'?{isMobile:mobile}:{})});
    await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
    if(initialize)await context.addInitScript(initialize);
    const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await run(page,server,context);assert.deepEqual(errors,[]);
  } finally {await browser?.close();await server.close();}
}
const job=(id,state='completed')=>({id,kind:'command',state,command:'printf "한글 원문 <script>" '+id,target:'fixture',createdAt:1000,expiresAt:2000000000000,
  result:{structuredContent:{output:{id:'b'.repeat(48),state:'ready',bytes:21}}}});

const historyIds=async page=>{await historyReady(page);return page.locator('#history article[data-request-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.requestId).sort());};
const dated=(id,iso,state='completed')=>({...job(id,state),createdAt:Date.parse(iso)});
test('history dates include both local calendar boundaries and filter creation rather than finish time',async()=>fixture(async(page,server)=>{
  server.state.jobs=[dated('before','2026-10-17T14:59:59.999Z'),dated('start','2026-10-17T15:00:00Z'),{...dated('middle','2026-10-18T03:00:00Z'),finishedAt:Date.parse('2026-10-20T00:00:00Z')},dated('end','2026-10-18T14:59:59.999Z'),dated('after','2026-10-18T15:00:00Z'),{...job('unknown'),createdAt:null}];
  await page.goto(server.origin+'/history');assert.equal(await page.getByLabel('시작일',{exact:true}).count(),1);
  await page.getByLabel('시작일',{exact:true}).fill('2026-10-18');await page.getByLabel('종료일',{exact:true}).fill('2026-10-18');
  assert.deepEqual(await historyIds(page),['end','middle','start']);assert.match(await page.locator('.history-date-note').textContent(),/요청 생성일.*Asia\/Seoul.*포함/);
  assert.equal(server.state.requests.some(r=>r.method==='POST'),false);
},{timezoneId:'Asia/Seoul'}));
test('history dates handle a 25 hour daylight saving day including both repeated hours',async()=>fixture(async(page,server)=>{
  server.state.jobs=[dated('before','2026-11-01T03:59:59.999Z'),dated('start','2026-11-01T04:00:00Z'),dated('first-hour','2026-11-01T05:30:00Z'),dated('second-hour','2026-11-01T06:30:00Z'),dated('end','2026-11-02T04:59:59.999Z'),dated('after','2026-11-02T05:00:00Z')];
  await page.goto(server.origin+'/history');await page.getByLabel('Start date',{exact:true}).fill('2026-11-01');await page.getByLabel('End date',{exact:true}).fill('2026-11-01');
  assert.deepEqual(await historyIds(page),['end','first-hour','second-hour','start']);assert.match(await page.locator('.history-date-note').textContent(),/America\/New_York/);
},{timezoneId:'America/New_York',locale:'en-US'}));
test('open history date bounds and clear dates keep search and status filters',async()=>fixture(async(page,server)=>{
  server.state.jobs=[dated('match-old','2026-10-16T12:00:00Z'),dated('match-day','2026-10-18T12:00:00Z'),dated('match-new','2026-10-20T12:00:00Z'),dated('match-failed','2026-10-18T12:00:00Z','failed'),dated('other','2026-10-18T12:00:00Z')];
  await page.goto(server.origin+'/history');await page.getByRole('searchbox',{name:'이력 검색'}).fill('match-');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  await page.getByLabel('시작일',{exact:true}).fill('2026-10-18');assert.deepEqual(await historyIds(page),['match-day','match-new']);
  await page.getByLabel('시작일',{exact:true}).fill('');await page.getByLabel('종료일',{exact:true}).fill('2026-10-18');assert.deepEqual(await historyIds(page),['match-day','match-old']);
  await page.getByRole('button',{name:'기간 초기화',exact:true}).click();await historyReady(page);assert.deepEqual(await historyIds(page),['match-day','match-new','match-old']);assert.equal(await page.getByLabel('처리 상태',{exact:true}).inputValue(),'completed');assert.equal(await page.getByRole('searchbox',{name:'이력 검색'}).inputValue(),'match-');
},{timezoneId:'UTC'}));
test('invalid history dates show an accessible error without stale results or changing live queues',async()=>fixture(async(page,server)=>{
  server.state.jobs=[dated('match','2026-10-18T12:00:00Z'),job('waiting-date','pending'),job('running-date','running')];
  await page.goto(server.origin+'/history');await page.getByLabel('시작일',{exact:true}).fill('2026-10-20');await page.getByLabel('종료일',{exact:true}).fill('2026-10-18');
  assert.equal(await page.locator('#history article[data-request-id]').count(),0);await page.getByText('종료일은 시작일과 같거나 이후여야 합니다.',{exact:true}).waitFor();assert.equal(await page.getByLabel('시작일',{exact:true}).getAttribute('aria-invalid'),'true');
  await page.locator('[data-page-link][href="/"]').click();assert.equal(await page.locator('#pending-count').textContent(),'1');assert.equal(await page.locator('#running-count').textContent(),'1');
  await page.locator('[data-page-link][href="/history"]').click();await page.getByLabel('시작일',{exact:true}).fill('2026-10-18');assert.deepEqual(await historyIds(page),['match']);assert.equal(await page.locator('#history-date-error').isVisible(),false);assert.equal(await page.getByLabel('시작일',{exact:true}).getAttribute('aria-invalid'),'false');
},{timezoneId:'UTC'}));
test('history dates reset pagination and combine with target, status and text search',async()=>fixture(async(page,server)=>{
  server.state.multiTarget=true;server.state.jobs=[...Array.from({length:24},(_,i)=>({...dated('match-'+String(i).padStart(2,'0'),'2026-10-18T12:00:00Z'),targetId:'alpha'})),{...dated('other-day','2026-10-19T12:00:00Z'),targetId:'alpha'},{...dated('match-beta','2026-10-18T12:00:00Z'),targetId:'beta'},{...dated('match-failed','2026-10-18T12:00:00Z','failed'),targetId:'alpha'}];
  await page.goto(server.origin+'/history');await page.selectOption('#target-filter','alpha');await page.getByRole('searchbox',{name:'이력 검색'}).fill('match-');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  await page.locator('#history-pagination').getByRole('button',{name:'다음',exact:true}).click();await historyReady(page);assert.equal(await page.locator('#history article[data-request-id]').count(),4);
  await page.getByLabel('시작일',{exact:true}).fill('2026-10-18');await page.getByLabel('종료일',{exact:true}).fill('2026-10-18');await historyReady(page);assert.equal(await page.locator('#history article[data-request-id]').count(),20);assert.equal(await page.locator('#history article[data-request-id]').first().getAttribute('data-request-id'),'match-23');assert.equal(await page.locator('#history-count').textContent(),'20');
  await page.getByRole('searchbox',{name:'이력 검색'}).fill('absent');await page.getByText('검색 조건에 맞는 승인 이력이 없습니다',{exact:true}).waitFor();assert.equal(await page.locator('#history-pagination').isVisible(),false);
},{timezoneId:'UTC'}));
test('history dates survive navigation and refresh while loaded output is read only once',async()=>fixture(async(page,server)=>{
  server.state.jobs=[dated('persistent','2026-10-18T12:00:00Z')];await page.goto(server.origin+'/history');await page.getByLabel('시작일',{exact:true}).fill('2026-10-18');await page.getByLabel('종료일',{exact:true}).fill('2026-10-18');
  await openRequest(page);await page.getByRole('button',{name:'출력 보기',exact:true}).click();await page.getByText('EXPLICIT_WEB_SENTINEL',{exact:true}).waitFor();
  await page.locator('[data-page-link][href="/settings"]').click();await page.goBack();assert.equal(await page.getByLabel('시작일',{exact:true}).inputValue(),'2026-10-18');assert.equal(await page.getByLabel('종료일',{exact:true}).inputValue(),'2026-10-18');
  const before=server.state.reads;await page.locator('#load').click();await page.waitForFunction(()=>!document.querySelector('#load').disabled);assert.ok(server.state.reads>before);assert.equal(await page.locator('#history article[data-request-id]').evaluate(n=>n.classList.contains('is-selected')),true);assert.equal(await page.locator('#request-output').textContent(),'EXPLICIT_WEB_SENTINEL');assert.equal(server.state.outputReads,1);assert.equal(server.state.requests.some(r=>r.method==='POST'),false);
},{timezoneId:'UTC'}));

test('history has an independent route and keeps filters, expanded DOM and loaded output across tabs/back/forward',async()=>fixture(async(page,server)=>{
  server.state.multiTarget=true;server.state.jobs=[{...job('history-alpha'),targetId:'alpha'},{...job('history-beta'),targetId:'beta'},job('waiting','pending')];
  await page.goto(server.origin+'/');await page.locator('#jobs .request').waitFor();assert.equal(await page.locator('#history-panel').isVisible(),false);
  await page.locator('[href="/history"]').focus();await page.keyboard.press('Enter');await page.waitForURL('**/history');
  assert.equal(await page.locator('.work-column').isVisible(),false);await page.selectOption('#target-filter','alpha');
  await page.getByRole('searchbox',{name:'이력 검색'}).fill('history-alpha');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  const record=page.locator('#history article[data-request-id]');await record.locator('[data-request-detail]').click();await page.getByRole('button',{name:'출력 보기',exact:true}).click();
  await page.getByText('EXPLICIT_WEB_SENTINEL',{exact:true}).waitFor();await record.evaluate(node=>window.savedHistory=node);
  await page.locator('[href="/settings"]').click();await page.goBack();
  assert.equal(await page.getByRole('searchbox',{name:'이력 검색'}).inputValue(),'history-alpha');assert.equal(await page.locator('#target-filter').inputValue(),'alpha');
  assert.equal(await page.getByLabel('처리 상태',{exact:true}).inputValue(),'completed');assert.equal(await record.evaluate(node=>node===window.savedHistory&&node.classList.contains('is-selected')),true);
  await page.goForward();await page.locator('[href="/history"]').click();assert.equal(await page.getByText('EXPLICIT_WEB_SENTINEL',{exact:true}).isVisible(),true);assert.equal(server.state.outputReads,1);
  assert.equal(await page.getByRole('region',{name:'요청 내용',exact:true}).textContent(),server.state.jobs[0].command);assert.equal(await page.locator('script').count(),1);
}));

test('filtered history pagination uses the filtered anchor and direct entry survives refresh on mobile',async()=>fixture(async(page,server)=>{
  server.state.jobs=Array.from({length:46},(_,i)=>({...job('item-'+String(i).padStart(2,'0'),i%2?'completed':'failed'),createdAt:1000-i}));
  await page.goto(server.origin+'/history');await page.getByLabel('처리 상태',{exact:true}).selectOption('completed');
  await page.getByRole('searchbox',{name:'이력 검색'}).fill('item-');await page.locator('#history-pagination').getByRole('button',{name:'다음',exact:true}).click();await historyReady(page);
  assert.equal(await page.locator('#history article[data-request-id]').first().getAttribute('data-request-id'),'item-41');
  await page.locator('[data-page-link][href="/"]').click();await page.locator('[href="/history"]').click();assert.equal(await page.locator('#history article[data-request-id]').first().getAttribute('data-request-id'),'item-41');
  await page.reload();assert.equal(await page.locator('[href="/history"]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('#history-panel').isVisible(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/history-mobile.png',fullPage:true});
},{width:390}));

test('explicit language overrides browser language, persists across reload/navigation and stores no token or draft',async()=>fixture(async(page,server)=>{
  server.state.jobs=[job('원문')];await page.goto(server.origin+'/preferences');assert.equal(await page.locator('html').getAttribute('lang'),'ko');
  await navigate(page,'/preferences');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(await page.getByLabel('Administrator display language',{exact:true}).inputValue(),'en');
  assert.equal(await page.getByRole('navigation',{name:'Management navigation',exact:true}).count(),1);
  await page.locator('[data-page-link][href="/history"]').click();await openRequest(page);
  assert.equal(await page.getByRole('region',{name:'요청 내용',exact:true}).textContent(),server.state.jobs[0].command);
  await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'en'});assert.equal(server.state.requests.some(x=>x.method==='POST'),false);
}));

test('Korean selection works in English browser, and automatic restores browser detection',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/preferences');await navigate(page,'/preferences');await page.getByLabel('Administrator display language',{exact:true}).selectOption('ko');await page.getByRole('button',{name:'Apply language and reload'}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='ko');await navigate(page,'/preferences');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('auto');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');
},{locale:'en-US'}));

test('disabled storage shows an accessible error',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/preferences');assert.equal(await page.locator('html').getAttribute('lang'),'ko');await navigate(page,'/preferences');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.getByText('언어 설정을 저장할 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.',{exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),'ko');
},{initialize:()=>Object.defineProperty(window,'localStorage',{get(){throw Error('disabled');}})}));

test('English settings translate dynamic command controls, input errors and ENV labels without changing server values',async()=>fixture(async(page,server)=>{
  server.state.commandAutomation=true;const posts=[];
  await page.route('**/api/command-policy',route=>{posts.push(route.request().method());return route.fulfill({json:{revision:1,bindings:[{targetId:'default',targetRevision:'v1',profile:'fixture',displayName:'자동승인 설정'}],targets:[],evaluators:{jev:{models:['jev-1.14.0'],defaultModel:'jev-1.14.0'}}}});});
  await page.route('**/api/environment',route=>route.fulfill({json:{available:true,revision:'a'.repeat(64),fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'자동승인 설정'}],readOnlyKeys:[],restart:{state:'idle'}}}));
  await page.goto(server.origin+'/settings');await selectServer(page,'default');await page.getByRole('tab',{name:'Commands',exact:true}).waitFor();
  await page.getByText('Registered commands',{exact:true}).waitFor();await page.locator('.command-direct summary').click();await page.getByLabel('Command name to add',{exact:true}).fill('ls -l');await page.getByRole('button',{name:'Add to preapproval draft',exact:true}).click();
  await page.getByText('Enter a command name without options, e.g. ls instead of ls -l.',{exact:true}).waitFor();
  assert.match(await page.locator('#server-target option:checked').textContent(),/자동승인 설정 \[default\]/);await navigate(page,'/bridge');await page.getByLabel('Bridge display name',{exact:true}).waitFor();assert.equal(await page.getByLabel('Bridge display name',{exact:true}).inputValue(),'자동승인 설정');assert.deepEqual([...new Set(posts)],['GET']);await navigate(page,'/settings');
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
  await page.getByLabel('시작일',{exact:true}).fill('1969-01-01');await page.getByLabel('종료일',{exact:true}).fill('1971-01-01');await historyReady(page);assert.equal(await page.locator('#history article[data-request-id]').count(),13);await openRequest(page,'matrix-0');await page.getByRole('button',{name:'출력 보기',exact:true}).first().click();await page.locator('#request-output').first().waitFor();await fits('history-ko');
  const scrollEnd=async(selector)=>{const n=page.locator(selector).first();await n.hover();const original=await n.textContent();// Firefox limits a single wheel delta; repeat real input while preserving the end-position oracle.
    for(let attempt=0;attempt<200;attempt++){if(await n.evaluate(n=>n.scrollTop+n.clientHeight>=n.scrollHeight-2))break;await page.mouse.wheel(0,600);await page.waitForTimeout(80);}
    await page.waitForFunction(selector=>{const n=document.querySelector(selector);return n.scrollHeight>n.clientHeight&&n.scrollTop+n.clientHeight>=n.scrollHeight-2;},selector);assert.equal(await n.textContent(),original);geometry.push({stage:'scroll-end-'+selector,...await n.evaluate(n=>({top:n.scrollTop,height:n.clientHeight,total:n.scrollHeight}))});};
  await scrollEnd('#request-detail-body [role=region][aria-label="요청 내용"]');await scrollEnd('#request-output');assert.equal(outputReads,1);
  await page.locator('.intro').hover();for(let attempt=0;attempt<200;attempt++){if(await page.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-3))break;await page.mouse.wheel(0,600);await page.waitForTimeout(80);}await page.waitForFunction(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-3);geometry.push({stage:'page-bottom',reached:true});
  await page.locator('[data-page-link][href="/settings"]').click();await selectServer(page,'default');await page.getByRole('tab',{name:'명령 관리',exact:true}).waitFor();await fits('settings-ko');
  await page.getByRole('button',{name:'명령 찾아 추가',exact:true}).click();const detailBeforeScroll=await page.locator('.command-detail').textContent();await scrollEnd('.command-table-scroll');const sticky=await page.locator('.command-table-scroll').evaluate(n=>({top:n.getBoundingClientRect().top,head:n.querySelector('th').getBoundingClientRect().top}));assert.ok(Math.abs(sticky.top-sticky.head)<3,JSON.stringify(sticky));assert.equal(await page.locator('.command-detail').textContent(),detailBeforeScroll);await page.getByLabel('명령 검색',{exact:true}).fill('pwd');await page.getByRole('button',{name:'pwd 상세 보기',exact:true}).click();
  assert.match(await page.locator('.command-detail').textContent(),/pwd/);await fits('command-detail-ko');
  await navigate(page,'/preferences');await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');
  await navigate(page,'/bridge');await page.getByLabel('Bridge display name',{exact:true}).waitFor();assert.equal(await page.getByLabel('Bridge display name',{exact:true}).inputValue(),'서버 원문');await fits('bridge-en');await navigate(page,'/settings');await selectServer(page,'default');await page.getByRole('tab',{name:'Commands',exact:true}).waitFor();await fits('settings-en');if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/settings-'+viewport.name+'.png',fullPage:true});
  for(const tabName of ['Permissions · TEST','Jev and models','Review and save','Commands']){await page.getByRole('tab',{name:tabName,exact:true}).click();await fits('tab-'+tabName);}
  await page.locator('[data-page-link][href="/history"]').click();await page.getByRole('searchbox',{name:'Search history'}).fill('matrix-2');await page.getByLabel('Request status',{exact:true}).selectOption('failed');
  await page.getByLabel('Start date',{exact:true}).fill('1969-01-01');await page.getByLabel('End date',{exact:true}).fill('1971-01-01');await historyReady(page);assert.equal(await page.locator('#history article[data-request-id]').count(),3);await fits('history-en');await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'en');await fits('history-en-reload');
  await page.locator('[data-page-link][href="/"]').click();await page.locator('#jobs').focus();await page.keyboard.press('PageDown');await page.waitForFunction(()=>scrollY>0);await page.locator('#running').focus();await page.keyboard.press('PageDown');await fits('approval-queues');await page.locator('[data-page-link][href="/history"]').click();
  assert.equal(server.state.requests.some(r=>r.method==='POST'),false);assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'en'});
  if(process.env.UI_SCREENSHOTS){const fs=await import('node:fs/promises');await fs.writeFile(process.env.UI_SCREENSHOTS+'/matrix-'+viewport.name+'.json',JSON.stringify(geometry,null,2));await page.screenshot({path:process.env.UI_SCREENSHOTS+'/matrix-'+viewport.name+'.png',fullPage:true});}
},viewport));


test('invalid saved language safely uses browser detection without changing other storage',async()=>fixture(async(page,server)=>{
  await page.goto(server.origin+'/preferences');assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(await page.getByLabel('Administrator display language',{exact:true}).inputValue(),'auto');
  assert.deepEqual(await page.evaluate(()=>({...localStorage})),{'ssh-approval-language':'unsupported','unrelated-preference':'keep'});assert.equal(server.state.requests.some(r=>r.method==='POST'),false);
},{locale:'en-US',initialize:()=>{localStorage.setItem('ssh-approval-language','unsupported');localStorage.setItem('unrelated-preference','keep');}}));

for (const locale of ['ko-KR','en-US']) test('UI168 불완전 이력은 정상 0건과 구별하고 다음 완전 조회에서 경고를 해제한다 '+locale,async()=>fixture(async(page,server)=>{
  const korean=locale==='ko-KR';let incomplete=false,items=[];
  await page.route(/\/api\/history(?:\?|$)/,route=>route.fulfill({json:{items,nextCursor:null,asOf:Date.now(),observedAt:Date.now(),coverage:{commandJournal:true,cliJournal:true,fileHistory:'memory-only',snapshot:false,registeredTargetsOnly:true,cliCurrentBindingOnly:true,metadataIncomplete:incomplete}}}));
  await page.goto(server.origin+'/history');await historyReady(page);
  const coverage=page.locator('#history-coverage'),status=page.locator('#history-query-status'),search=page.getByRole('searchbox',{name:korean?'이력 검색':'Search history'});
  assert.equal(await coverage.getAttribute('data-incomplete'),'false');assert.equal(await page.locator('#history-count').textContent(),'0');
  assert.doesNotMatch(await status.textContent(),/불완전|incomplete/i);
  incomplete=true;await search.fill('excluded-empty');await historyReady(page);
  assert.equal(await coverage.getAttribute('data-incomplete'),'true');assert.equal(await page.locator('#history article[data-request-id]').count(),0);
  assert.match(await coverage.textContent(),korean?/일부 기록 제외.*모든 기록을 보장하지 않습니다/:/Some records excluded.*does not represent complete history/);
  assert.match(await status.textContent(),korean?/0건이어도 기록이 없다고 판단할 수 없습니다/:/zero results do not establish that no history exists/);
  await page.getByText(korean?'일부 기록이 제외되어 조회가 불완전합니다':'History results are incomplete',{exact:true}).waitFor();
  if(process.env.UI_SCREENSHOTS)await page.screenshot({path:process.env.UI_SCREENSHOTS+'/history-incomplete-empty-'+locale+'.png',fullPage:true});
  items=[{...job('excluded-with-row-verifiable-retained'),history:{stateSource:'journal',storage:'command',targetStatus:'active'}}];
  await search.fill('excluded-with-row');await historyReady(page);
  assert.equal(await page.locator('#history article[data-request-id="excluded-with-row-verifiable-retained"]').count(),1);assert.equal(await coverage.getAttribute('data-incomplete'),'true');assert.match(await status.textContent(),korean?/확인 가능한 기록 1건.*불완전 조회/:/Showing 1 verifiable requests.*incomplete/);
  incomplete=false;items=[];await search.fill('complete-empty');await historyReady(page);
  assert.equal(await coverage.getAttribute('data-incomplete'),'false');assert.equal(await page.locator('#history-count').textContent(),'0');
  assert.doesNotMatch(await coverage.textContent(),/일부 기록 제외|Some records excluded/);assert.doesNotMatch(await status.textContent(),/불완전|incomplete/i);
  assert.match(await coverage.textContent(),korean?/파일 이력은 현재 메모리/:/File history is memory-only/);assert.equal(server.state.requests.some(request=>request.method==='POST'),false);
},{locale}));
