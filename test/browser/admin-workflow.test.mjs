import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureServer} from './fixture-server.mjs';
import {launchBrowser} from './browser.mjs';
import {openRequest, navigate, historyReady, permissionsTab, cliTab, environmentGroups} from './admin-ui.mjs';
import {createApplication} from '../../app.mjs';
import {createCommandState} from '../../src/adapters/storage/command-state.mjs';

const revision = 'b'.repeat(64), root = fileURLToPath(new URL('../../', import.meta.url));
const bindings = ['alpha','beta'].map(targetId => ({targetId,targetRevision:revision,profile:targetId+'-write',displayName:'같은 서버 이름',sshTarget:'fixture@'+targetId,enabled:true,supported:true,platform:'linux'}));
const pending = (id,targetId) => ({id,kind:'command',state:'pending',command:'printf synthetic-review',targetId,targetRevision:revision,profile:targetId+'-write',hostKey:'SHA256:'+targetId,targetDisplayName:'같은 서버 이름',target:'fixture@'+targetId,createdAt:Date.now()-1000,expiresAt:Date.now()+600000});
async function screenshot(page,width,stage) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), stage+' 화면의 가로 넘침');
  if(process.env.UI_SCREENSHOTS) await page.screenshot({path:join(process.env.UI_SCREENSHOTS,'admin-168-'+width+'-'+stage+'.png'),fullPage:true});
}

for(const width of [320,390,760,820,1120,1440]) test('UI168 동일 이름 대상·상태 상세·서버 초안·관리 범위 '+width, {timeout:30000}, async () => {
  const server=await fixtureServer(root);let browser;
  server.state.multiTarget=server.state.commandAutomation=true;
  server.state.targets=bindings.map(binding=>({id:binding.targetId,displayName:binding.displayName,enabled:true,platform:'linux'}));
  server.state.jobs=[pending('same-name-alpha','alpha'),pending('same-name-beta','beta')];
  server.state.agentCli=async(request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({available:true,providers:[{id:'codex'},{id:'claude'}],bindings}));};
  try {
    browser=await launchBrowser();const page=await browser.newPage({locale:'ko-KR',viewport:{width,height:900}});page.setDefaultTimeout(7000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
    await page.route('**/api/command-policy',route=>route.fulfill({json:{revision:1,bindings,testServerAvailable:true,targets:bindings.map(binding=>({targetId:binding.targetId,targetRevision:revision,profile:binding.profile,commands:['pwd','ls'],deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,fallback:null,thresholds:{}}))}}));
    await page.route('**/api/environment',route=>route.fulfill({json:{available:true,revision:'env-fixture',pendingRestart:false,restart:{state:'idle'},readOnlyKeys:['BRIDGE_ADMIN_TOKEN'],fields:[
      {key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'합성 운영 중계기'},
      {key:'BRIDGE_JEV_ENABLED',label:'Jev 평가 사용',type:'boolean',value:'false'},
      {key:'JEV_API_KEY',label:'Jev API 키',type:'secret',configured:true}
    ]}}));
    const text='합성 출력 원문 <script>window.outputInjected=true</script>\n'+'긴 출력 행\n'.repeat(180);let outputReads=0;
    await page.route('**/api/outputs/*',route=>{outputReads++;return route.fulfill({json:{text,offsetBytes:0,nextOffset:Buffer.byteLength(text),totalBytes:Buffer.byteLength(text),eof:true}});});
    await page.goto(server.origin+'/');await page.locator('#jobs article[data-request-id]').first().waitFor();
    assert.equal(await page.locator('#command-policy').isVisible(),false);assert.equal(await page.locator('#environment-editor').isVisible(),false);
    await screenshot(page,width,'approval-list');
    const opener=page.locator('#jobs [data-request-detail="same-name-alpha"]');await opener.focus();await page.keyboard.press('Enter');
    await page.locator('#request-detail-title').waitFor();assert.equal(await page.locator('#request-detail-title').evaluate(node=>node===document.activeElement),true);
    assert.match(await page.locator('#request-detail-target').textContent(),/같은 서버 이름.*\[alpha\]/);
    assert.doesNotMatch(await page.locator('#request-detail-target').textContent(),/\[beta\]/);
    await screenshot(page,width,'selected-request');
    await page.locator('#request-output').evaluate(node=>window.savedOutput=node);
    await page.locator('#request-detail-body').getByRole('button',{name:'승인·실행',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#request-detail-state').dataset.state==='running');
    assert.deepEqual(server.state.requests.filter(request=>request.method==='POST'),[{method:'POST',id:'same-name-alpha',action:'approve'}]);
    assert.equal(server.state.jobs[1].state,'pending');
    server.state.jobs[0]={...server.state.jobs[0],state:'completed',finishedAt:Date.now(),result:{structuredContent:{output:{id:'c'.repeat(48),state:'ready',bytes:Buffer.byteLength(text)}}}};
    await page.locator('#load').click();await page.waitForFunction(()=>document.querySelector('#request-detail-state').dataset.state==='completed');
    assert.equal(await page.locator('#request-detail-body').getAttribute('data-request-id'),'same-name-alpha');assert.equal(await page.locator('#request-output').evaluate(node=>node===window.savedOutput),true);
    assert.match(await page.locator('#request-announcement').textContent(),/same-name-alpha/);
    const read=page.locator('#request-detail-body').getByRole('button',{name:'출력 보기',exact:true});await read.focus();await page.keyboard.press('Enter');
    const output=page.getByRole('region',{name:'실행 출력',exact:true});await output.waitFor();assert.equal(await output.textContent(),text);assert.equal(await output.evaluate(node=>node===document.activeElement),true);
    await page.keyboard.press('PageDown');await page.waitForFunction(()=>document.querySelector('#request-output').scrollTop>0);const scroll=await output.evaluate(node=>node.scrollTop);
    assert.equal(await page.evaluate(()=>window.outputInjected),undefined);await screenshot(page,width,'completed-output');
    await navigate(page,'/settings');assert.equal(await page.locator('#server-target').inputValue(),'');assert.equal(await page.locator('#policy-effective-state').getAttribute('data-test-mode'),'unselected');await page.locator('#request-return').click();await page.waitForURL(url=>url.pathname==='/');
    assert.equal(await output.textContent(),text);assert.equal(await output.evaluate(node=>node===window.savedOutput&&node.scrollTop),scroll);assert.equal(outputReads,1);
    await navigate(page,'/settings');await page.locator('#server-target option[value=alpha]').waitFor({state:'attached'});await page.locator('#server-target').selectOption('alpha');await permissionsTab(page);
    const testMode=page.getByRole('checkbox',{name:/^테스트 서버/});assert.equal(await testMode.isChecked(),false);await testMode.check();
    assert.equal(await page.locator('#policy-effective-state').getAttribute('data-test-mode'),'off');assert.match(await page.locator('#policy-effective-state').textContent(),/아직 적용되지/);
    await page.locator('#server-target').selectOption('beta');assert.equal(await testMode.isChecked(),false);await page.locator('#server-target').selectOption('alpha');assert.equal(await testMode.isChecked(),true);
    assert.match(await page.locator('#server-edit-context').textContent(),/alpha/);await screenshot(page,width,'server-policy');
    await cliTab(page);assert.match(await page.locator('#cli-target-context').textContent(),/alpha/);assert.equal(await page.locator('#cli-target').isVisible(),false);
    await screenshot(page,width,'server-cli');
    await navigate(page,'/bridge');await page.locator('#env-BRIDGE_DISPLAY_NAME').waitFor();await environmentGroups(page);
    assert.equal(await page.locator('#server-workspace').isVisible(),false);assert.equal(await page.locator('#environment-editor').isVisible(),true);assert.equal(await page.locator('#appearance-settings').isVisible(),false);
    assert.match(await page.locator('#environment-editor').textContent(),/모든 대상/);assert.equal(await page.locator('#env-JEV_API_KEY').inputValue(),'');await screenshot(page,width,'bridge');
    await navigate(page,'/preferences');assert.equal(await page.locator('#appearance-settings').isVisible(),true);assert.equal(await page.locator('#environment-editor').isVisible(),false);await screenshot(page,width,'preferences');
    await navigate(page,'/history');await historyReady(page);await openRequest(page,'same-name-alpha');assert.match(await page.locator('#history-coverage').textContent(),/파일 이력은 현재 메모리/);await screenshot(page,width,'history');
    await navigate(page,'/');await openRequest(page,'same-name-beta','#jobs');await page.locator('#request-close').focus();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#request-detail').isVisible(),false);assert.equal(await page.locator('#jobs [data-request-detail="same-name-beta"]').evaluate(node=>node===document.activeElement),true);
    assert.equal(server.state.requests.filter(request=>request.method==='POST').length,1);assert.deepEqual(errors,[]);
  } finally {await browser?.close();await server.close();}
});

test('UI168 실제 기존 장부의 24시간 초과 기록을 날짜로 조회하며 실행하지 않는다', {timeout:30000}, async () => {
  const directory=await mkdtemp(join(tmpdir(),'ui168-old-journal-'));let app,browser;
  const id='d'.repeat(48),createdAt=Date.parse('2020-01-02T12:00:00Z');
  const journal=createCommandState(directory);
  try {journal.insert({id,kind:'command',command:'printf OLD_ARCHIVE_CANARY',operation:{kind:'command',command:'printf OLD_ARCHIVE_CANARY'},profile:'aws-local',targetId:'default',target:'fixture',state:'completed',createdAt,finishedAt:createdAt+1000,expiresAt:createdAt+600000,result:{failed:false,texts:['PRIVATE_ARCHIVE_OUTPUT']}},null,'synthetic-digest');} finally {journal.close();}
  try {
    let executions=0;app=await createApplication({registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>{executions++;return {texts:[]};},audit:()=>{},transferRoot:directory,uiHtml:'<html></html>',
      env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_UI_TICKET_KEY:'a'.repeat(64)}});
    assert.equal(app.queue.listAll().some(job=>job.id===id),false,'대기열이 아닌 기존 저장 장부를 읽어야 한다');
    await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+app.adminHttp.address().port;
    browser=await launchBrowser();const page=await browser.newPage({locale:'ko-KR',timezoneId:'UTC',viewport:{width:1440,height:900}});page.setDefaultTimeout(7000);const decisions=[],history=[];
    page.on('request',request=>{const url=new URL(request.url());if(/\/(approve|deny)$/.test(url.pathname))decisions.push(request);if(url.pathname==='/api/history')history.push(url);});
    await page.goto(origin+'/history');await page.locator('#token').fill('fixture-owner');await page.locator('#load').click();await historyReady(page);
    await page.getByLabel('시작일',{exact:true}).fill('2020-01-02');await page.getByLabel('종료일',{exact:true}).fill('2020-01-02');await page.getByRole('searchbox',{name:'이력 검색'}).fill('OLD_ARCHIVE_CANARY');await historyReady(page);
    await openRequest(page,id);assert.match(await page.locator('#request-detail-state').textContent(),/저장 기록/);assert.match(await page.locator('#request-detail-body').textContent(),/OLD_ARCHIVE_CANARY/);
    assert.doesNotMatch(await page.locator('body').textContent(),/PRIVATE_ARCHIVE_OUTPUT/);assert.equal(await page.locator('#request-detail-body').getByRole('button',{name:'승인·실행',exact:true,includeHidden:true}).isVisible(),false);
    const query=history.at(-1).searchParams;assert.equal(query.get('from'),'1577923200000');assert.equal(query.get('to'),'1578009600000');assert.equal(query.get('q'),'OLD_ARCHIVE_CANARY');assert.equal(decisions.length,0);assert.equal(executions,0);
    await screenshot(page,1440,'old-journal');
  } finally {await browser?.close();await app?.close();await rm(directory,{recursive:true,force:true});}
});
