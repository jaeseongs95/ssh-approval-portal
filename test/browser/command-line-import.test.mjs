import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, browserName } from './browser.mjs';
import { createApplication } from '../../app.mjs';

async function fixture(run, {width=390,locale='ko-KR',names=['pwd'],history=false,historyCommand='printf "PRIVATE_COMMAND_CANARY" && ls'}={}) {
  const root=await mkdtemp(join(tmpdir(),'command-import-browser-'));assert.equal(dirname(root),resolve(tmpdir()));let app,browser,hold;
  let executions=0,modelCalls=0,failPolicyRead=false;const posts=[],releases=[];
  try {
    app=await createApplication({registry:{getProfile:name=>({host:'127.0.0.1',port:name.startsWith('beta')?23:22,user:name.split('-')[0],trustedHostKey:'SHA256:'+name.split('-')[0],readOnly:name.endsWith('-read')}),closeAll:async()=>{}},classify:()=>{throw Error('UI import must not classify or execute a command');},executeCommand:async()=>{executions++;throw Error('UI import must not execute commands');},audit:()=>{},transferRoot:root,uiHtml:'<html></html>',policyRiskAssessor:{assess:async()=>{modelCalls++;throw Error('No real evaluator in import tests');}},env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_COMMAND_AUTOMATION:'true',BRIDGE_DEFAULT_TARGET:'alpha',BRIDGE_TARGETS:JSON.stringify(['alpha','beta'].map(id=>({id,displayName:id,readProfile:id+'-read',writeProfile:id+'-write',credentialRevision:'fixture-v1'})))}});
    await new Promise(r=>app.adminHttp.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.adminHttp.address().port;
    const api=async(path,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer fixture-owner',Origin:'https://owner.test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(r.status,200,await r.clone().text());return r.json();};
    const initial=await api('/api/command-policy'),binding=initial.bindings.find(b=>b.targetId==='alpha');
    const rule={...binding,commands:names,deniedCommands:['rm'],externalDisclosure:false,modelExecution:false,automaticSudo:false,automaticUploads:false,automaticDownloads:false,sourceExecutionContract:null,fallback:null,thresholds:{jev:{model:'jev-1.14.0',questionVersion:'ssh-command-risk-v4',basis:'safety-probability-v1',minLowRisk:.7,validationRef:'user-choice:fixture'}}};delete rule.displayName;delete rule.enabled;
    const proposal={expectedRevision:initial.revision,policy:{targets:[rule]}};const reviewed=await api('/api/command-policy/review',proposal);await api('/api/command-policy',{...proposal,reviewToken:reviewed.reviewToken,acknowledged:true});
    const completed=(command='pwd && ls')=>{const job=app.queue.submitOperation({kind:'command',command},'privileged','alpha');const stored=app.queue.jobs.get(job.id);stored.state='completed';stored.finishedAt=Date.now();return stored;};
    const job=history?completed(historyCommand):null;
    browser=await launchBrowser();const context=await browser.newContext({locale,viewport:{width,height:844},hasTouch:width<600,...(browserName==='chromium'?{isMobile:width<600}:{})});
    const errors=[];
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
      if(url.pathname==='/api/command-policy'&&route.request().method()==='GET'&&hold){const gate=hold;hold=undefined;gate.started();await gate.promise;}
      if(url.pathname==='/api/command-policy'&&route.request().method()==='GET'&&failPolicyRead){failPolicyRead=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic unavailable'})});}
      if(process.env.POLICY_UX_ROOT&&url.pathname==='/app.js')return route.fulfill({status:200,contentType:'text/javascript',body:await readFile(join(process.env.POLICY_UX_ROOT,'web/dist/app.js'),'utf8')});
      if(process.env.POLICY_UX_ROOT&&['/','/settings','/history'].includes(url.pathname)){
        const r=await route.fetch({maxRedirects:0});const source=await r.text(),candidate=await readFile(join(process.env.POLICY_UX_ROOT,'web/index.html'),'utf8');
        return route.fulfill({response:r,body:source.replace(/<style>[\s\S]*?<\/style>/,candidate.match(/<style>[\s\S]*?<\/style>/)[0])});
      }
      if(route.request().method()==='POST'){posts.push({path:url.pathname,body:route.request().postDataJSON()});const r=await route.fetch({maxRedirects:0,headers:{...route.request().headers(),origin:'https://owner.test'}});return route.fulfill({response:r});}
      try{return await route.continue();}catch{/* An explicitly abandoned navigation may dispose the old request. */}
    });
    const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    const ready=async()=>{await page.waitForFunction(expected=>document.querySelector('.command-bulk textarea')?.value===expected,names.join('\n'));};
    const open=async(path='/settings')=>{await page.goto(origin+path);await page.locator('#token').fill('fixture-owner');await page.locator('#load').click();await ready();if(path==='/settings'){await page.locator('#command-policy .settings-tabs [role=tab]').first().click();const bulk=page.locator('.command-bulk');if(!await bulk.evaluate(n=>n.open))await bulk.locator('summary').click();}};
    const importer=page.locator('.command-import'),source=importer.locator('textarea');
    const paste=async command=>{await page.getByRole('button',{name:locale.startsWith('ko')?'명령줄 붙여넣기':'Paste a command line',exact:true}).click();await source.fill(command);await importer.getByRole('button',{name:locale.startsWith('ko')?'명령 이름 추출':'Extract command names',exact:true}).click();};
    const holdNext=()=>{let release,started;const promise=new Promise(r=>{release=r;}),began=new Promise(r=>{started=r;});releases.push(release);hold={promise,started};return{release,began};};
    await run({page,context,app,api,open,paste,importer,source,posts,rule,binding,job,completed,holdNext,failNextRead:()=>{failPolicyRead=true;},counters:()=>({executions,modelCalls})});assert.deepEqual(errors,[]);
  }finally{releases.forEach(release=>release());await browser?.close();await app?.close();assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
}

for(const width of [320,390,768,1024,1440])for(const locale of ['ko-KR','en-US'])test('command import review/save and scroll '+width+' '+locale,async()=>fixture(async f=>{
  const {page,source,importer}=f;await f.open();await f.paste('pwd && ls "PRIVATE_COMMAND_CANARY" | grep home; rm /tmp/example');
  assert.equal(await importer.getByRole('checkbox',{name:'pwd',exact:true}).isDisabled(),true);assert.equal(await importer.getByRole('checkbox',{name:'rm',exact:true}).isDisabled(),true);assert.equal(await importer.locator('input:checked').count(),0);assert.equal(f.posts.length,0);
  await importer.getByRole('checkbox',{name:'ls',exact:true}).check();await importer.getByRole('button',{name:locale.startsWith('ko')?'선택한 이름을 초안에 추가':'Add selected names to draft',exact:true}).click();assert.equal(f.posts.length,0);
  await page.locator('#command-policy .settings-tabs [role=tab]').last().click();const save=page.locator('#command-policy button[type=submit]');assert.equal(await save.isDisabled(),true);
  await page.locator('#command-policy button.primary[type=button]').click();const ack=page.locator('#command-policy .policy-section').last().locator('input[type=checkbox]');await ack.waitFor({state:'visible'});await ack.check();const saved=page.waitForResponse(r=>r.url().endsWith('/api/command-policy')&&r.request().method()==='POST');await save.click();assert.equal((await saved).status(),200);
  const current=(await f.api('/api/command-policy')).targets.find(r=>r.targetId==='alpha');assert.deepEqual(current.commands,['pwd','ls']);assert.deepEqual(current.deniedCommands,['rm']);assert.deepEqual(current.thresholds,f.rule.thresholds);assert.equal(current.automaticSudo,false);assert.equal(current.externalDisclosure,false);assert.equal(current.modelExecution,false);assert.doesNotMatch(JSON.stringify(f.posts),/PRIVATE_COMMAND_CANARY/);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
  await page.locator('#command-policy .settings-tabs [role=tab]').first().click();assert.equal(await source.inputValue(),'');
  if(!await page.locator('.command-bulk').evaluate(n=>n.open))await page.locator('.command-bulk>summary').click();await f.paste(Array.from({length:60},(_,i)=>'cmd'+String(i).padStart(3,'0')).join(' && '));
  const region=importer.locator('.command-import-candidates');await region.focus();await importer.getByRole('checkbox').last().focus();await page.keyboard.press('Space');assert.equal(await importer.getByRole('checkbox').last().isChecked(),true);assert.ok(await region.evaluate(n=>n.scrollTop>0&&n.scrollHeight>n.clientHeight));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.doesNotMatch(JSON.stringify(await page.evaluate(()=>({...localStorage}))),/PRIVATE_COMMAND_CANARY|cmd059/);
  await page.locator('.command-master select').selectOption('all');await page.locator('.command-master>button').last().click();const grid=page.locator('.command-table-scroll');await grid.hover();await page.mouse.wheel(0,600);await page.waitForFunction(()=>document.querySelector('.command-table-scroll').scrollTop>0);const bounds=await grid.evaluate(n=>({top:n.getBoundingClientRect().top,header:n.querySelector('th').getBoundingClientRect().top}));assert.ok(Math.abs(bounds.top-bounds.header)<=3);
},{width,locale}));

test('unsupported/stale source never stages partial names or posts',async()=>fixture(async f=>{
  await f.open();for(const line of ['pwd && id &&','pwd; $COMMAND','pwd\nrm /tmp/example']){await f.paste(line);assert.equal(await f.importer.getByRole('checkbox').count(),0);assert.equal(f.posts.length,0);}
  await f.paste('ls && grep x');await f.importer.getByRole('checkbox',{name:'ls',exact:true}).check();await f.source.fill('rm /tmp/new');assert.equal(await f.importer.getByRole('checkbox').count(),0);assert.equal(await f.page.locator('.command-bulk textarea').first().inputValue(),'pwd');assert.equal(f.posts.length,0);
}));
test('name limit rejects a whole selected batch and scope changes clear the private command',async()=>fixture(async f=>{
  await f.open();await f.paste('newone && newtwo');
  await f.importer.getByRole('button',{name:'전체 선택',exact:true}).click();await f.importer.getByRole('button',{name:'선택한 이름을 초안에 추가',exact:true}).click();assert.equal((await f.page.locator('.command-bulk textarea').first().inputValue()).split('\n').length,128);assert.equal(f.posts.length,0);
  await f.page.locator('#important-settings select').first().selectOption('beta');assert.equal(await f.source.inputValue(),'');assert.equal(await f.importer.evaluate(n=>n.open),false);
},{names:Array.from({length:128},(_,i)=>'c'+i)}));
test('history completed command opens matching target with no selected names or policy post',async()=>fixture(async f=>{
  await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).click();await f.page.waitForFunction(()=>document.querySelector('.command-import textarea')?.value.includes('PRIVATE_COMMAND_CANARY'));
  assert.equal(new URL(f.page.url()).pathname,'/settings');assert.equal(await f.importer.locator('input:checked').count(),0);assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
},{history:true}));
for(const field of ['targetRevision','profile'])test('history mismatched '+field+' cannot prefill a new policy',async()=>fixture(async f=>{
  f.job[field]='stale';await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();const read=f.page.waitForResponse(r=>r.url().endsWith('/api/command-policy')&&r.request().method()==='GET');await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).click();await read;await f.page.waitForFunction(()=>!document.querySelector('#command-policy button.primary[type=button]').disabled);assert.equal(await f.source.inputValue(),'');assert.equal(await f.page.getByText('이력의 연결 정보가 현재 정책 대상과 다릅니다. 현재 설정을 확인해 주세요.',{exact:true}).isVisible(),true);assert.equal(f.posts.length,0);
},{history:true}));

test('history without a binding has a disabled import button',async()=>fixture(async f=>{
  delete f.job.targetRevision;await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();assert.equal(await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).isDisabled(),true);assert.equal(f.posts.length,0);
},{history:true}));

for(const state of ['pending','running'])test(state+' command does not offer history registration',async()=>fixture(async f=>{
  f.job.state=state;delete f.job.finishedAt;await f.open('/');const card=f.page.locator('[data-request-id="'+f.job.id+'"]');await card.waitFor();assert.equal(await card.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).count(),0);assert.equal(f.posts.length,0);
},{history:true}));

test('non-command history does not offer command registration',async()=>fixture(async f=>{
  f.job.operation=Object.freeze({kind:'download',remotePath:'/tmp/synthetic',elevate:false});f.job.state='failed';await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();assert.equal(await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).count(),0);assert.equal(f.posts.length,0);
},{history:true}));

test('submitted source history does not register its executor as a command name',async()=>fixture(async f=>{
  f.job.operation=Object.freeze({...f.job.operation,sourceContract:'python-source-v1',sourceBytes:8,sourceSha256:'a'.repeat(64),sourceCwd:'/tmp',sourceArgvJson:'[]',sourceElevate:false});await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();assert.equal(await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).count(),0);assert.equal(f.posts.length,0);
},{history:true}));

test('logout clears a pasted command and a delayed history import cannot restore it',async()=>fixture(async f=>{
  await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();const gate=f.holdNext();await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).click();await gate.began;
  await f.page.evaluate(()=>{document.querySelector('#logout').click();});gate.release();await f.page.waitForURL(url=>url.pathname==='/');assert.equal(await f.source.inputValue(),'');assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
},{history:true}));
test('history navigation while binding reload is pending discards late prefill',async()=>fixture(async f=>{
  await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();const gate=f.holdNext();await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).click();await gate.began;await f.page.locator('[data-page-link][href="/history"]').click();const done=f.page.waitForResponse(r=>r.url().endsWith('/api/command-policy')&&r.request().method()==='GET');gate.release();await done;await f.page.waitForFunction(()=>!document.querySelector('#command-policy button.primary[type=button]').disabled);assert.equal(new URL(f.page.url()).pathname,'/history');assert.equal(await f.source.inputValue(),'');assert.equal(f.posts.length,0);
},{history:true}));

test('failed policy reload clears private import at request start and keeps it cleared after failure',async()=>fixture(async f=>{
  await f.open();await f.paste('ls "PRIVATE_COMMAND_CANARY" && grep home');await f.importer.getByRole('checkbox',{name:'ls',exact:true}).check();
  const gate=f.holdNext();f.failNextRead();await f.page.getByRole('button',{name:'서버 설정 다시 불러오기',exact:true}).click();await gate.began;assert.equal(await f.source.inputValue(),'');assert.equal(await f.importer.getByRole('checkbox').count(),0);
  const response=f.page.waitForResponse(r=>r.url().endsWith('/api/command-policy')&&r.status()===503);gate.release();await response;await f.page.waitForFunction(()=>!document.querySelector('.policy-toolbar button').disabled);assert.equal(await f.source.inputValue(),'');assert.equal(await f.importer.evaluate(n=>n.open),false);assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
}));

test('oversized paste never silently truncates the command before extraction',async()=>fixture(async f=>{
  await f.open();await f.page.getByRole('button',{name:'명령줄 붙여넣기',exact:true}).click();const line='ls'+' '.repeat(32766)+' && rm /tmp/synthetic';await f.source.focus();
  if(browserName==='chromium'){await f.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(f.page.url()).origin});await f.page.evaluate(value=>navigator.clipboard.writeText(value),line);await f.page.keyboard.press('Control+V');}else await f.page.keyboard.insertText(line);
  assert.equal(await f.source.inputValue(),line);await f.importer.getByRole('button',{name:'명령 이름 추출',exact:true}).click();assert.equal(await f.importer.getByRole('checkbox').count(),0);assert.equal(await f.page.locator('.command-bulk textarea').first().inputValue(),'pwd');assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
}));

for(const width of [320,1440])test('LIMIT-BROWSER full 32KiB paste retains tail and browser layout '+width,async()=>fixture(async f=>{
 await f.open();const tail=' && id',line='ls '+' '.repeat(32768-3-tail.length)+tail;await f.paste(line);
 assert.equal(await f.source.inputValue(),line);assert.equal(await f.importer.getByRole('checkbox',{name:'id',exact:true}).count(),1);
 assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
 const textarea=await f.source.evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight}));assert.ok(textarea.scroll>=textarea.height);
 assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await f.paste('printf '+'가'.repeat(11000));assert.equal(await f.importer.getByRole('checkbox').count(),0);
 assert.match(await f.importer.locator('[role=status]').innerText(),/32KiB/);
},{width}));

test('LIMIT-HISTORY full 32KiB command imports from completed history without truncation or save',async()=>fixture(async f=>{
 const command='ls '+' '.repeat(32768-3-6)+' && id';
 await f.open('/history');await f.page.locator('[data-request-id="'+f.job.id+'"]>summary').click();
 await f.page.getByRole('button',{name:'이력의 명령 이름 등록',exact:true}).click();
 await f.page.waitForFunction(expected=>document.querySelector('.command-import textarea')?.value===expected,command,{timeout:3000});
 assert.equal(await f.source.inputValue(),command);assert.equal(await f.importer.getByRole('checkbox',{name:'id',exact:true}).count(),1);
 assert.equal(f.posts.length,0);assert.deepEqual(f.counters(),{executions:0,modelCalls:0});
},{history:true,historyCommand:'ls '+' '.repeat(32768-3-6)+' && id'}));
