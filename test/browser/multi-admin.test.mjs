import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {launchBrowser} from './browser.mjs';
import {fixtureServer} from './fixture-server.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const binding=id=>({targetId:id,targetRevision:(id==='alpha'?'a':'b').repeat(64),profile:id+'-write',displayName:'동일 이름',enabled:true});
const rule=id=>({...Object.fromEntries(Object.entries(binding(id)).filter(([key])=>!['displayName','enabled'].includes(key))),commands:['id'],deniedCommands:[],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}});
const job=(id,targetId='alpha',state='pending')=>({id,targetId,targetDisplayName:'동일 이름',targetRevision:binding(targetId).targetRevision,hostKey:'SHA256:'+targetId,kind:'command',state,target:'fixture',command:'printf '+id+' '+('long command '.repeat(8)),createdAt:1000,expiresAt:2000000000000});
const bulk=async page=>{await page.getByRole('tab',{name:'명령 관리',exact:true}).click();if(!await page.locator('.command-bulk').evaluate(n=>n.open))await page.locator('.command-bulk summary').click();};
async function fixture(run,{width=1280,locale='ko-KR',envAvailable=false,disabled=false}={}){
  const server=await fixtureServer(process.env.UI_SOURCE_ROOT??root);let browser;
  const model={revision:1,targets:['alpha','beta'].map(rule),bindings:['alpha','beta'].map(binding)};
  if(disabled)model.bindings[0].enabled=false;
  server.state.multiTarget=true;server.state.commandAutomation=true;
  server.state.targets=['alpha','beta'].map(id=>({id,displayName:'동일 이름',enabled:!disabled||id!=='alpha',isDefault:id==='alpha'}));
  const posts=[],errors=[];
  try{
    browser=await launchBrowser();const context=await browser.newContext({locale,viewport:{width,height:900}});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());if(url.origin!==server.origin)return route.abort();
      if(url.pathname==='/api/command-policy'&&request.method()==='GET')return route.fulfill({json:model});
      if(url.pathname==='/api/command-policy/review'){posts.push({path:url.pathname,body:request.postDataJSON()});return route.fulfill({json:{reviewToken:'synthetic-review',expiresAt:Date.now()+300000,feedback:[],notice:'Synthetic review only'}});}
      if(url.pathname==='/api/command-policy'&&request.method()==='POST'){const body=request.postDataJSON();posts.push({path:url.pathname,body});model.targets=body.policy.targets;model.revision++;return route.fulfill({json:{revision:model.revision,targets:model.targets}});}
      if(url.pathname==='/api/environment')return route.fulfill({json:{available:envAvailable,revision:'env-synthetic',fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'fixture'}],readOnlyKeys:[],pendingRestart:false}});
      if(url.pathname==='/api/automation-metrics')return route.fulfill({json:{available:false,from:1,to:2}});
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
    await run({page,context,server,model,posts});assert.deepEqual(errors,[]);
  }finally{await browser?.close();await server.close();}
}

for(const width of [320,375,390,760,800,820,1440])test('query/policy scopes, draft/search and keyboard scroll remain independent at '+width,()=>fixture(async({page,server,posts})=>{
  server.state.jobs=[...Array.from({length:16},(_,i)=>job('a-'+i)),...Array.from({length:16},(_,i)=>job('run-'+i,'alpha','running')),job('beta-only','beta')];
  await page.goto(server.origin+'/');await page.locator('#jobs article').first().waitFor();
  await page.selectOption('#target-filter','alpha');await page.waitForFunction(()=>!document.querySelector('#load').getAttribute('aria-busy')||document.querySelector('#load').getAttribute('aria-busy')==='false');
  for(const id of ['jobs','running']){
    const region=page.locator('#'+id);assert.equal(await region.getAttribute('role'),'region');assert.equal(await region.getAttribute('tabindex'),'0');
    await region.focus();await page.keyboard.press('PageDown');await page.waitForFunction(id=>document.getElementById(id).scrollTop>0,id);
    assert.ok(await region.evaluate(n=>n.scrollHeight>n.clientHeight));
  }
  const oldScroll=await page.locator('#jobs').evaluate(n=>n.scrollTop);
  const approve=page.locator('#jobs article').first().getByRole('button',{name:'승인·실행',exact:true});
  assert.match(await approve.getAttribute('aria-describedby'),/^request-target-/);
  const description=await approve.evaluate(n=>document.getElementById(n.getAttribute('aria-describedby')).textContent);assert.match(description,/alpha/);assert.match(description,/a{64}/);
  await page.selectOption('#target-filter','beta');await page.locator('#jobs article .command').filter({hasText:'beta-only'}).waitFor();
  await page.getByRole('button',{name:'이 서버 정책 열기',exact:true}).click();
  await page.getByLabel('정책 편집 대상',{exact:true}).selectOption('alpha');await bulk(page);
  await page.getByLabel('자동승인할 명령',{exact:true}).fill('id\npwd');await page.getByLabel('명령 검색',{exact:true}).fill('pwd');
  await page.getByRole('link',{name:'승인',exact:true}).click();
  assert.equal(await page.locator('#target-filter').inputValue(),'beta','policy navigation does not retarget queries');
  await page.getByRole('button',{name:'이 서버 정책 열기',exact:true}).click();
  assert.equal(await page.getByLabel('정책 편집 대상',{exact:true}).inputValue(),'beta');assert.equal(await page.locator('#target-filter-label').isVisible(),false);
  assert.match(await page.locator('#server-identity').textContent(),/중계기 설정/);assert.doesNotMatch(await page.locator('#server-identity').textContent(),/alpha|beta/);
  const options=await page.getByLabel('정책 편집 대상',{exact:true}).locator('option').allTextContents();assert.ok(options.some(n=>n.includes('[alpha]'))&&options.some(n=>n.includes('[beta]')));
  await page.getByLabel('정책 편집 대상',{exact:true}).selectOption('alpha');await bulk(page);
  assert.equal(await page.getByLabel('자동승인할 명령',{exact:true}).inputValue(),'id\npwd');assert.equal(await page.getByLabel('명령 검색',{exact:true}).inputValue(),'pwd');
  assert.match(await page.locator('#environment-editor h2').textContent(),/중계기 전체/);assert.match(await page.locator('#environment-editor').textContent(),/모든 대상/);
  await page.getByRole('link',{name:'승인',exact:true}).click();await page.selectOption('#target-filter','alpha');
  assert.ok(await page.locator('#jobs').evaluate(n=>n.scrollTop)>=oldScroll-2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.equal(posts.length,0);
},{width}));

test('language discard confirmation preserves all target drafts on cancel and only then stores preference',()=>fixture(async({page,server,posts})=>{
  await page.goto(server.origin+'/settings');await page.getByLabel('정책 편집 대상',{exact:true}).waitFor();await bulk(page);await page.getByLabel('자동승인할 명령',{exact:true}).fill('id\npwd');
  await page.getByLabel('정책 편집 대상',{exact:true}).selectOption('beta');await bulk(page);await page.getByLabel('자동승인할 명령',{exact:true}).fill('id\nls');
  await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');
  let message;page.once('dialog',async dialog=>{message=dialog.message();await dialog.dismiss();});await page.getByRole('button',{name:'언어 적용·새로고침'}).click();
  assert.match(message,/alpha/);assert.match(message,/beta/);assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null);
  assert.equal(await page.getByLabel('자동승인할 명령',{exact:true}).inputValue(),'id\nls');assert.equal(posts.length,0);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');
  assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),'en');assert.equal(posts.length,0);
}));

test('lost policy save blocks language reload and target jumps without replaying POST',()=>fixture(async({page,server,posts})=>{
  await page.route('**/api/command-policy',async route=>{if(route.request().method()==='GET')return route.fallback();posts.push({path:'/api/command-policy'});return route.abort();});
  server.state.jobs=[job('beta-only','beta')];await page.goto(server.origin+'/settings');await page.getByLabel('정책 편집 대상',{exact:true}).waitFor();await bulk(page);await page.getByLabel('자동승인할 명령',{exact:true}).fill('id\npwd');
  await page.getByRole('tab',{name:'검토·저장',exact:true}).click();await page.getByRole('button',{name:'이 설정으로 위험도 확인',exact:true}).click();await page.getByRole('checkbox',{name:/^위험도와 변경 내용을/}).check();await page.getByRole('button',{name:'이 서버에 저장',exact:true}).click();
  await page.getByText(/저장을 확인하지 못했습니다\./).waitFor();await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();
  await page.getByText(/처리 중이거나 결과 확인이 필요한 작업/).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null);
  await page.getByRole('link',{name:'승인',exact:true}).click();await page.getByRole('button',{name:'이 서버 정책 열기',exact:true}).click();assert.equal(await page.getByLabel('정책 편집 대상',{exact:true}).inputValue(),'alpha');
  assert.equal(posts.filter(p=>p.path==='/api/command-policy').length,1);
}));

test('ENV dirty/busy/uncertain blocks or confirms language change without printing or persisting secret inputs',()=>fixture(async({page,server})=>{
  await page.goto(server.origin+'/settings');const input=page.locator('#env-BRIDGE_DISPLAY_NAME');await input.fill('unsaved-name');
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'언어 적용·새로고침'}).click();assert.equal(await input.inputValue(),'unsaved-name');
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);let posts=0;
  await page.route('**/api/environment',async route=>{if(route.request().method()==='GET')return route.fallback();posts++;entered();await new Promise(resolve=>release=resolve);await route.abort().catch(()=>{});});
  await page.locator('#environment-editor input[type=checkbox]').last().check();await page.getByRole('button',{name:'ENV 저장',exact:true}).click();await waiting;
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.getByText(/처리 중이거나 결과 확인이 필요한 작업/).waitFor();release();await page.getByText(/저장됐을 수도 있으므로/).waitFor();
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();assert.equal(await input.inputValue(),'unsaved-name');assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null);assert.equal(posts,1);
},{envAvailable:true}));

test('a hung query is superseded immediately; late responses cannot replace the selected target',()=>fixture(async({page,server})=>{
  server.state.jobs=[job('alpha-only'),job('beta-only','beta')];await page.goto(server.origin+'/');await page.locator('#jobs article').first().waitFor();
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);let calls=0;
  await page.route('**/api/requests',async route=>{calls++;if(calls!==1)return route.fallback();entered();await new Promise(resolve=>release=resolve);await route.fulfill({json:[job('stale-alpha')]}).catch(()=>{});});
  await page.selectOption('#target-filter','alpha');await waiting;await page.selectOption('#target-filter','beta');
  await page.waitForFunction(()=>document.querySelector('#load').getAttribute('aria-busy')==='false');assert.ok(calls>=2);assert.equal(await page.locator('#jobs article').count(),1);assert.match(await page.locator('#jobs .command').textContent(),/beta-only/);
  release();await page.locator('#load').click();assert.doesNotMatch(await page.locator('#jobs').textContent(),/stale-alpha/);assert.equal(server.state.requests.some(r=>r.method==='POST'),false);
}));

test('old metrics from A to B to A are discarded by generation including page changes',()=>fixture(async({page,server})=>{
  await page.goto(server.origin+'/');await page.locator('#target-filter').waitFor();await page.selectOption('#target-filter','alpha');
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);let count=0;
  await page.route('**/api/automation-metrics*',async route=>{count++;if(count===1){entered();await new Promise(resolve=>release=resolve);return route.fulfill({json:{available:true,from:0,to:0,total:999,providers:{}}}).catch(()=>{});}return route.fulfill({json:{available:false,from:count*100000,to:count*100000}});});
  await page.locator('#automation-metrics summary').click();await waiting;await page.selectOption('#target-filter','beta');await page.selectOption('#target-filter','alpha');await page.getByRole('link',{name:'설정',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#automation-metrics button').disabled===false);release();
  assert.doesNotMatch(await page.locator('#automation-metrics').textContent(),/999|beta/);assert.match(await page.locator('#automation-metrics').textContent(),/alpha/);
}));

test('inactive policy deletion is explicit and reviewed; duplicate request IDs expose no approval buttons',()=>fixture(async({page,server,posts})=>{
  server.state.jobs=[job('duplicate'),job('duplicate','beta')];await page.goto(server.origin+'/');await page.getByText(/중복된 요청 ID/).waitFor();assert.equal(await page.locator('#jobs article button').count(),0);
  await page.getByRole('link',{name:'설정',exact:true}).click();const removal=page.getByRole('checkbox',{name:/alpha.*현재 미적용/});await removal.check();await page.getByRole('tab',{name:'검토·저장',exact:true}).click();
  await page.getByRole('button',{name:'이 설정으로 위험도 확인',exact:true}).click();await page.getByRole('checkbox',{name:/^위험도와 변경 내용을/}).waitFor({state:'visible'});assert.deepEqual(posts[0].body.policy.targets.map(t=>t.targetId),['beta']);assert.equal(posts.length,1);
},{disabled:true}));

test('lost approval response blocks language until a current request status reconciles without a second POST',()=>fixture(async({page,server})=>{
  server.state.jobs=[job('approval-unknown')];let posts=0,failedReads=false;
  await page.route('**/api/requests',route=>failedReads?route.fulfill({status:503,json:{error:'read temporarily unavailable'}}):route.fallback());
  await page.route('**/api/approval-unknown/approve',route=>{posts++;server.state.jobs[0].state='running';failedReads=true;return route.abort();});
  await page.goto(server.origin+'/');await page.getByRole('button',{name:'승인·실행',exact:true}).click();await page.getByText(/승인·거부 결과.*read temporarily unavailable/).waitFor();
  await page.getByRole('link',{name:'설정',exact:true}).click();await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();
  await page.getByText(/처리 중이거나 결과 확인이 필요한 작업/).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null);assert.equal(posts,1);
  failedReads=false;server.state.jobs[0].state='pending';await page.locator('#load').click();await page.waitForFunction(()=>document.querySelector('#load').getAttribute('aria-busy')==='false');
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null,'pending alone cannot prove the lost approval was never received');
  server.state.jobs[0].state='running';await page.locator('#load').click();await page.waitForFunction(()=>document.querySelector('#load').getAttribute('aria-busy')==='false');
  await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(posts,1);assert.equal(server.state.jobs[0].state,'running');
}));

test('download link POST blocks language while pending and cannot navigate after an explicit page change',()=>fixture(async({page,server})=>{
  server.state.jobs=[{...job('download-busy','alpha','completed'),kind:'download',operation:{remotePath:'/tmp/synthetic.bin'}}];
  let release,entered;const started=new Promise(resolve=>entered=resolve);let posts=0;
  await page.route('**/api/download-busy/download',async route=>{posts++;entered();await new Promise(resolve=>release=resolve);await route.fulfill({json:{downloadUrl:'/fixture/download/download-busy'}}).catch(()=>{});});
  await page.goto(server.origin+'/history');await page.locator('#history details summary').click();await page.locator('#history').getByRole('button',{name:'파일 저장',exact:true}).click();await started;
  await page.getByRole('link',{name:'설정',exact:true}).click();await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.getByText(/처리 중이거나 결과 확인이 필요한 작업/).waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('ssh-approval-language')),null);
  const finished=page.waitForResponse(response=>response.url().includes('/api/download-busy/download'));release();await finished;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(new URL(page.url()).pathname,'/settings');assert.equal(posts,1);
  await page.getByLabel('관리자 화면 언어',{exact:true}).selectOption('en');await page.getByRole('button',{name:'언어 적용·새로고침'}).click();await page.waitForFunction(()=>document.documentElement.lang==='en');assert.equal(new URL(page.url()).pathname,'/settings');
}));
