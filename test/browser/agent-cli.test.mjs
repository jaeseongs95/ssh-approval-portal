import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fixtureServer} from './fixture-server.mjs';
import {launchBrowser,browserName} from './browser.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),id='a'.repeat(48),revision='b'.repeat(64);
const savedJob=(requestId=id)=>({id:requestId,state:'completed',createdAt:1000,operation:{agentCliContract:'agent-cli-install-v1',agentCliProvider:'codex',agentCliTargetId:'alpha',agentCliTargetRevision:revision,agentCliProfile:'alpha-write'},result:{structuredContent:{output:{id:'d'.repeat(48)}}}});
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:()=>resolve()};};
async function fixture(run,{width=390,locale='ko-KR',compiled=false}={}){
 const f=await fixtureServer(root);f.state.compiled=compiled;let browser,context,page;
 const posts=[],gets=[],holds=new Map(),allHolds=[],jobs=new Map();let lostSubmit=false,lostStart=false,installed={},loginResult={state:'signed_in'},historyResult;
 const binding=targetId=>({targetId,targetRevision:revision,profile:targetId+'-write',displayName:targetId+' <server>',sshTarget:'mcpops@'+targetId+'.example',enabled:true});
 const p=provider=>({planId:'c'.repeat(48),binding:binding('alpha'),installation:{provider,installed:false,managed:false,version:null,installationRevision:'d'.repeat(64),login:'not_checked'},release:{provider,packageName:provider==='codex'?'@openai/codex':'@anthropic-ai/claude-code',version:'1.2.3',releaseDigest:'e'.repeat(64)},expiresAt:Date.now()+300000});
 f.state.agentCli=async(req,res,url)=>{
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;posts.push({path:url.pathname,body:JSON.parse(raw)});}else gets.push(url.pathname+url.search);
  const body=posts.at(-1)?.body,route=url.pathname.slice('/api/agent-cli'.length),hold=holds.get(route);if(hold){holds.delete(route);hold.entered.resolve();await hold.release.promise;}
  res.setHeader('Content-Type','application/json');const send=value=>res.end(JSON.stringify(value));
  if(route==='')return send({available:true,providers:[{id:'codex'},{id:'claude'}],bindings:['alpha','beta'].map(binding)});
  if(route==='/login-status')return send({binding:binding(body.targetId),provider:body.provider,checkedAt:Date.now(),...loginResult});
  if(route==='/preview'){const value=p(body.provider);value.binding=binding(body.targetId);Object.assign(value.installation,installed);return send(value);}
  if(route==='/submit'){const r=body.request,job={id,state:'pending',operation:{agentCliContract:'agent-cli-install-v1',agentCliProvider:r.provider,agentCliTargetId:r.targetId,agentCliTargetRevision:r.targetRevision,agentCliProfile:r.profile},result:null};jobs.set(r.requestKey,job);if(lostSubmit){lostSubmit=false;return res.destroy();}return send(job);}
  if(route==='/lookup'){const job=jobs.get(url.searchParams.get('key'));return send(job?{found:true,job,remoteStatus:null}:{found:false});}
  if(route==='/history')return send(typeof historyResult==='function'?historyResult(url):historyResult??{binding:binding(url.searchParams.get('targetId')),provider:url.searchParams.get('provider'),requests:[...jobs.values()].filter(job=>job.operation.agentCliTargetId===url.searchParams.get('targetId')&&job.operation.agentCliProvider===url.searchParams.get('provider')).map(({id,state,createdAt})=>({id,state,createdAt})),next:null});
  if(route==='/start'){const job=[...jobs.values()].find(v=>v.id===body.requestId);job.state='running';if(lostStart){lostStart=false;return res.destroy();}return send(job);}
  const existing=/^\/requests\/([a-f0-9]{48})$/.exec(route);if(existing)return send({job:[...jobs.values()].find(job=>job.id===existing[1]),remoteStatus:null});
  if(route==='/reconcile')return send({requestId:id,remoteStatus:{provider:[...jobs.values()][0].operation.agentCliProvider,state:'not_found'}});
  res.writeHead(404);res.end('{}');
 };
 try{
  browser=await launchBrowser();context=await browser.newContext({locale,viewport:{width,height:844}});page=await context.newPage();page.setDefaultTimeout(10000);
  await page.addInitScript(()=>{const original=window.fetch;window.fixtureFetchCalls=[];window.fetch=(url,options)=>{window.fixtureFetchCalls.push({path:String(url).split('?')[0],method:options?.method??'GET'});return original(url,options);};});
  page.on('pageerror',error=>console.error('FIXTURE_PAGE_ERROR '+error.message));
  await page.goto(f.origin+'/settings');const panel=page.locator('#agent-cli-settings');await panel.waitFor();await page.locator('#cli-target option[value=alpha]').waitFor({state:'attached'});await page.locator('#cli-target').selectOption('alpha');
  await run({page,panel,posts,gets,jobs,context,origin:f.origin,setHistoryResult(value){historyResult=value;},setLoginResult(value){loginResult=value;},setInstallation(value){installed=value;},setLostSubmit(){lostSubmit=true;},setLostStart(){lostStart=true;},hold(route){const h={entered:gate(),release:gate()};holds.set(route,h);allHolds.push(h);return h;},prepare:async provider=>{if(provider)await page.locator('#cli-provider').selectOption(provider);await page.locator('#cli-inspect').click();await page.locator('#cli-summary').waitFor({state:'visible'});},create:async()=>{await page.locator('#cli-ack').check();await page.locator('#cli-submit').click();await page.locator('#cli-start').waitFor({state:'visible'});}});
 }finally{for(const h of allHolds)h.release.resolve();await context?.close();await browser?.close();await f.close();}
}

for(const locale of ['ko-KR','en-US'])for(const width of [320,390,768,1024,1440])test(`CLI UI ${browserName} ${locale} ${width}: scoped explicit flow, keyboard and scrolling`,()=>fixture(async f=>{
 const {page,panel,posts}=f;assert.equal(posts.length,0);assert.equal(await panel.locator('#cli-submit').isVisible(),false);
 await f.prepare();assert.equal(posts.length,1);assert.equal(await page.locator('#cli-submit').isDisabled(),true);assert.match(await page.locator('#cli-summary').textContent(),/@openai\/codex/);
 await page.locator('#cli-ack').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#cli-submit').isEnabled(),true);await page.locator('#cli-submit').dblclick();await page.locator('#cli-start').waitFor({state:'visible'});assert.equal(posts.filter(p=>p.path.endsWith('/submit')).length,1);assert.equal(posts.filter(p=>p.path.endsWith('/start')).length,0);assert.equal(await page.locator('#cli-start').isDisabled(),true);
 await page.locator('#cli-ack').check();await page.locator('#cli-start').dblclick();await page.waitForFunction(()=>document.querySelector('#cli-summary').textContent.includes('Installing')||document.querySelector('#cli-summary').textContent.includes('설치 실행 중'));assert.equal(posts.filter(p=>p.path.endsWith('/start')).length,1);
 const stored=await page.evaluate(()=>sessionStorage.getItem('ssh-approval-cli-requests-v1'));assert.ok(stored);const hints=JSON.parse(stored);assert.deepEqual(Object.keys(hints[0]).sort(),['provider','requestId','requestKey','targetId']);assert.doesNotMatch(stored,/token|planId|releaseDigest|profile|command/);
 await page.locator('#cli-login summary').click();await page.locator('#cli-login pre').scrollIntoViewIfNeeded();assert.match(await page.locator('#cli-login pre').textContent(),/codex" login --device-auth/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.evaluate(()=>scrollY>0));assert.equal(await page.locator('#agent-cli-settings script').count(),0);
 await page.reload();await page.locator('#cli-target option[value=alpha]').waitFor({state:'attached'});await page.locator('#cli-target').selectOption('alpha');await page.waitForFunction(()=>document.querySelector('#cli-summary').textContent.includes('aaaaaaaa'));assert.equal(posts.filter(p=>p.path.endsWith('/start')).length,1);assert.equal(posts.filter(p=>p.path.endsWith('/submit')).length,1);
},{locale,width}));

test('CLI UI both providers, lost submit/start responses recover with GET only',()=>fixture(async f=>{
 await f.prepare('claude');assert.match(await f.page.locator('#cli-summary').textContent(),/@anthropic-ai\/claude-code/);f.setLostSubmit();await f.page.locator('#cli-ack').check();await f.page.locator('#cli-submit').click();await f.page.waitForFunction(()=>!document.querySelector('#cli-recover').disabled);assert.equal(await f.page.evaluate(()=>fixtureFetchCalls.filter(p=>p.path.endsWith('/submit')).length),1);assert.equal(f.jobs.size,1);await f.page.locator('#cli-recover').click();await f.page.locator('#cli-start').waitFor({state:'visible'});
 f.setLostStart();await f.page.locator('#cli-ack').check();await f.page.locator('#cli-start').click();await f.page.waitForFunction(()=>!document.querySelector('#cli-recover').disabled);await f.page.locator('#cli-recover').click();await f.page.waitForFunction(()=>document.querySelector('#cli-summary').textContent.includes('설치 실행 중'));assert.equal(await f.page.evaluate(()=>fixtureFetchCalls.filter(p=>p.path==='/api/agent-cli/start').length),1);assert.equal(await f.page.evaluate(()=>fixtureFetchCalls.filter(p=>p.path.endsWith('/submit')).length),1);assert.equal(new Set(f.posts.filter(p=>p.path.endsWith('/submit')).map(p=>JSON.stringify(p.body))).size,1);
}));
test('CLI UI stale preview response cannot cross provider or page scopes',()=>fixture(async f=>{
 const h=f.hold('/preview');await f.page.locator('#cli-inspect').click();await h.entered.promise;await f.page.locator('#cli-provider').selectOption('claude');h.release.resolve();await f.page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.equal(await f.page.locator('#cli-summary').isVisible(),false);assert.equal(await f.page.locator('#cli-submit').isVisible(),false);
 const h2=f.hold('/preview');await f.page.locator('#cli-inspect').click();await h2.entered.promise;await f.page.locator('[data-page-link][href="/history"]').click();h2.release.resolve();await f.page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');await f.page.locator('[data-page-link][href="/settings"]').click();assert.equal(await f.page.locator('#cli-summary').isVisible(),false);assert.equal(f.posts.length,2);
}));
test('CLI UI missing record and unknown status never auto-submit; logout clears public hints',()=>fixture(async f=>{
 await f.prepare();await f.create();const job=[...f.jobs.values()][0];job.state='unknown';await f.page.locator('#cli-recover').click();await f.page.locator('#cli-reconcile').waitFor({state:'visible'});await f.page.locator('#cli-reconcile').click();assert.equal(await f.page.locator('#cli-inspect').isDisabled(),true);assert.equal(f.posts.filter(p=>p.path.endsWith('/submit')).length,1);
 f.jobs.clear();await f.page.locator('#cli-recover').click();await f.page.waitForFunction(()=>document.querySelector('#agent-cli-settings .policy-message').textContent.includes('찾지 못'));assert.equal(await f.page.locator('#cli-inspect').isDisabled(),true);assert.equal(f.posts.filter(p=>p.path.endsWith('/submit')).length,1);
 await f.page.locator('#logout').click();assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('ssh-approval-cli-requests-v1')),null);
}));
test('CLI UI late submit/start/output responses never replace the new target; output scroll stays local',()=>fixture(async f=>{
 const {page}=f;await f.prepare();const h=f.hold('/submit');await page.locator('#cli-ack').check();await page.locator('#cli-submit').click();await h.entered.promise;await page.locator('#cli-target').selectOption('beta');h.release.resolve();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.equal(await page.locator('#cli-start').isVisible(),false);assert.equal(await page.locator('#cli-summary').isVisible(),false);
 await page.locator('#cli-target').selectOption('alpha');await page.locator('#cli-start').waitFor({state:'visible'});const h2=f.hold('/start');await page.locator('#cli-ack').check();await page.locator('#cli-start').click();await h2.entered.promise;await page.locator('#cli-provider').selectOption('claude');h2.release.resolve();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.equal(await page.locator('#cli-summary').isVisible(),false);
 const job=[...f.jobs.values()][0];job.state='completed';job.result={structuredContent:{output:{id:'f'.repeat(48)}}};await page.locator('#cli-provider').selectOption('codex');await page.locator('#cli-output-read').waitFor({state:'visible'});
 await page.route('**/api/outputs/*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'<script>window.UNSAFE=true</script>\n'+'output\n'.repeat(1000)})}));await page.locator('#cli-output-read').click();await page.locator('#cli-output').waitFor({state:'visible'});await page.locator('#cli-output').focus();await page.keyboard.press('End');assert.ok(await page.locator('#cli-output').evaluate(n=>n.scrollHeight>n.clientHeight));assert.equal(await page.evaluate(()=>window.UNSAFE),undefined);
 const outputGate=gate(),entered=gate();await page.route('**/api/outputs/*',async route=>{entered.resolve();await outputGate.promise;try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'LATE_PREVIOUS_TARGET_OUTPUT'})});}catch{}});await page.locator('#cli-output-read').click();await entered.promise;await page.locator('#cli-target').selectOption('beta');outputGate.resolve();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.equal(await page.locator('#cli-output').textContent(),'');assert.equal(await page.locator('#cli-output').isVisible(),false);
}));
test('CLI UI invalid public hints are ignored and never become execution authority',()=>fixture(async f=>{
 await f.page.evaluate(()=>sessionStorage.setItem('ssh-approval-cli-requests-v1',JSON.stringify([{targetId:'alpha',provider:'codex',requestKey:'valid-key-0000000001',requestId:'a'.repeat(48),command:'MALICIOUS'}])));await f.page.reload();await f.page.locator('#cli-target option[value=alpha]').waitFor({state:'attached'});await f.page.locator('#cli-target').selectOption('alpha');assert.equal(await f.page.locator('#cli-recover').isEnabled(),true);assert.equal(f.posts.length,0);assert.equal(f.gets.some(p=>p.startsWith('/api/agent-cli/lookup')),false);
}));
for(const compiled of [false,true])for(const locale of ['ko-KR','en-US'])test('CLI-HISTORY cold browser reads an explicitly selected saved request and output without POST '+locale+' compiled='+compiled,()=>fixture(async f=>{
 const {page}=f;f.jobs.set('server-only-key-not-in-browser',savedJob());
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('ssh-approval-cli-requests-v1')),null);
 assert.equal(await page.locator('#cli-recover').isEnabled(),true,'existing server requests remain discoverable without local browser hints');
 assert.equal(f.gets.some(path=>path.startsWith('/api/agent-cli/history')),false);
 await page.locator('#cli-recover').click();await page.locator('#cli-history-select').waitFor({state:'visible'});
 assert.equal(await page.locator('#cli-history-select').inputValue(),'');assert.equal(await page.locator('#cli-output-read').isVisible(),false);
 await page.locator('#cli-history-select').selectOption(id);await page.locator('#cli-summary').waitFor({state:'visible'});assert.match(await page.locator('#cli-summary').textContent(),new RegExp(id));
 assert.equal(f.posts.length,0);assert.equal(await page.evaluate(()=>fixtureFetchCalls.some(c=>c.path.startsWith('/api/outputs/'))),false);
 await page.locator('#cli-output-read').click();await page.locator('#cli-output').waitFor({state:'visible'});assert.equal(await page.locator('#cli-output').textContent(),'EXPLICIT_WEB_SENTINEL');
 assert.equal(f.gets.filter(path=>path==='/api/agent-cli/requests/'+id).length,1);assert.equal(f.posts.length,0);assert.equal(await page.evaluate(()=>sessionStorage.getItem('ssh-approval-cli-requests-v1')),null);
},{locale,compiled}));
test('CLI-HISTORY older pages are explicit GET reads and retain the selected request ID',()=>fixture(async f=>{
 const {page}=f,ids=Array.from({length:21},(_,i)=>(100-i).toString(16).padStart(48,'0')),binding={targetId:'alpha',targetRevision:revision,profile:'alpha-write',enabled:true};f.jobs.set('older-server-only-record',savedJob(ids[20]));
 f.setHistoryResult(url=>({binding,provider:'codex',requests:(url.searchParams.has('before')?ids.slice(20):ids.slice(0,20)).map(id=>({id,state:'completed',createdAt:1000})),next:url.searchParams.has('before')?null:{before:1000,beforeId:ids[19]}}));
 assert.equal(await page.locator('#cli-recover').isEnabled(),true);await page.locator('#cli-recover').click();await page.locator('#cli-history-select').waitFor({state:'visible'});
 assert.equal(await page.locator('#cli-history-select option').count(),21);assert.equal(f.gets.filter(path=>path.startsWith('/api/agent-cli/history')).length,1);
 await page.locator('#cli-history-next').click();await page.locator('#cli-history-select option[value="'+ids[20]+'"]').waitFor({state:'attached'});
 assert.equal(await page.locator('#cli-history-select option').count(),2);assert.equal(f.gets.filter(path=>path.includes('before=1000')&&path.includes('beforeId='+ids[19])).length,1);
 await page.locator('#cli-history-select').selectOption(ids[20]);await page.locator('#cli-summary').waitFor({state:'visible'});assert.match(await page.locator('#cli-summary').textContent(),new RegExp(ids[20]));assert.equal(f.posts.length,0);
}));
for(const change of ['target','provider','page','logout'])test('CLI-HISTORY late history reply cannot cross '+change+' scope',()=>fixture(async f=>{
 const {page}=f;f.jobs.set('server-only-record',savedJob());assert.equal(await page.locator('#cli-recover').isEnabled(),true);const h=f.hold('/history');await page.locator('#cli-recover').click();await h.entered.promise;
 if(change==='target')await page.locator('#cli-target').selectOption('beta');else if(change==='provider')await page.locator('#cli-provider').selectOption('claude');else if(change==='page')await page.locator('[data-page-link][href="/history"]').click();else await page.locator('#logout').click();
 h.release.resolve();await page.waitForFunction(()=>!document.querySelector('#agent-cli-settings')||document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#cli-history-select:visible').count(),0);assert.equal(await page.locator('#cli-output:visible').count(),0);assert.equal(f.posts.length,0);
}));
test('CLI-HISTORY wrong-binding metadata is refused before a saved request can be selected',()=>fixture(async f=>{
 const {page}=f;f.setHistoryResult({binding:{targetId:'beta',targetRevision:revision,profile:'beta-write'},provider:'codex',requests:[{id,state:'completed',createdAt:1000}],next:null});
 assert.equal(await page.locator('#cli-recover').isEnabled(),true);await page.locator('#cli-recover').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#cli-history-select:visible').count(),0);assert.equal(f.gets.some(path=>path.startsWith('/api/agent-cli/requests/')),false);assert.equal(f.posts.length,0);
}));
for(const locale of ['ko-KR','en-US'])test('CLI UI external coexistence and managed update are explicit '+locale,()=>fixture(async f=>{
 const {page}=f;f.setInstallation({installed:true,managed:false,version:'1.2.2'});await f.prepare();assert.match(await f.panel.locator('.policy-message').textContent(),locale.startsWith('ko')?/별도 관리 경로/:/separate managed path/);assert.match(await page.locator('#cli-summary').textContent(),/1\.2\.2/);assert.match(await page.locator('#cli-summary').textContent(),/1\.2\.3/);await f.create();assert.equal(f.posts.at(-1).body.request.action,'install');
 await page.locator('#cli-target').selectOption('beta');f.setInstallation({installed:true,managed:true,version:'1.2.2'});await f.prepare();assert.match(await page.locator('#cli-submit').textContent(),locale.startsWith('ko')?/업데이트/:/update/);await f.create();assert.equal(f.posts.at(-1).body.request.action,'update');
},{locale}));

for(const locale of ['ko-KR','en-US'])test('CLI-LOGIN UI explicit status and account/Node guidance '+locale,()=>fixture(async f=>{
 const {page}=f;assert.equal(f.posts.length,0);assert.match(await page.locator('#cli-login-state').textContent(),locale.startsWith('ko')?/미조회/:/Not checked/);
 for(const provider of ['codex','claude']){
  await page.locator('#cli-provider').selectOption(provider);
  for(const state of ['signed_in','signed_out','not_installed','unavailable']){
   f.setLoginResult({state,email:'SYNTHETIC_PRIVATE'});await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');
   assert.match(await page.locator('#cli-login-state').textContent(),locale.startsWith('ko')?/확인 시각/:/Checked/);const labels={signed_in:['로그인됨','Signed in'],signed_out:['로그인 안 됨','Signed out'],not_installed:['미설치','Not installed'],unavailable:['확인 불가','Unavailable']};assert.ok((await page.locator('#cli-login-state').textContent()).includes(labels[state][locale.startsWith('ko')?0:1]));assert.doesNotMatch(await f.panel.textContent(),/SYNTHETIC_PRIVATE/);
   assert.deepEqual(f.posts.at(-1).body,{targetId:'alpha',provider});
  }
  await page.locator('#cli-login').evaluate(n=>n.open=true);assert.match(await page.locator('#cli-login pre').textContent(),/PATH="\/opt\/ssh-approval\/node\/bin:\$PATH"/);
  assert.match(await page.locator('#cli-login-account').textContent(),/sudo -iu mcpops/);
 }
 assert.equal(f.posts.length,8);assert.equal(f.posts.every(p=>p.path.endsWith('/login-status')),true);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('ssh-approval-cli-requests-v1')),null);
 f.setLoginResult({state:'signed_in',binding:{targetId:'wrong'}});await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.match(await page.locator('#cli-login-state').textContent(),locale.startsWith('ko')?/확인 불가/:/Unavailable/);
},{locale}));
test('CLI-LOGIN UI late results cannot cross target/provider/page/logout scopes',()=>fixture(async f=>{
 const {page}=f;await page.route('**/signed-out',route=>route.fulfill({status:204}));
 for(const change of [()=>page.locator('#cli-provider').selectOption('claude'),()=>page.locator('#cli-target').selectOption('beta'),()=>page.locator('[data-page-link][href="/history"]').click(),()=>page.locator('#logout').click()]){
  const h=f.hold('/login-status');await page.locator('#cli-login-check').click();await h.entered.promise;await change();h.release.resolve();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.doesNotMatch(await page.locator('#cli-login-state').textContent(),/로그인됨|Signed in/);
  if(await page.locator('body').getAttribute('data-page')==='history')await page.locator('[data-page-link][href="/settings"]').click();
 }
 assert.equal(f.posts.length,4);
}));

test('LOGOUT compiled administrator UI revokes locally and reconnects without global logout',()=>fixture(async f=>{
 const {page}=f,calls=[];page.on('request',r=>calls.push({path:new URL(r.url()).pathname,method:r.method()}));
 await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#cli-login-state').textContent.includes('로그인됨'));
 await page.locator('#logout').click();await page.waitForURL('**/signed-out');assert.match(await page.locator('body').textContent(),/Administrator signed out/);
 assert.equal(calls.filter(c=>c.path==='/api/session/logout'&&c.method==='POST').length,1);assert.equal(calls.some(c=>['/cdn-cgi/access/logout','/oauth2/sign_out'].includes(c.path)),false);
 await page.getByRole('link',{name:'Reconnect administrator'}).click();await page.locator('#agent-cli-settings').waitFor({state:'attached'});await page.waitForFunction(()=>fixtureFetchCalls.some(c=>c.path==='/api/session/start'&&c.method==='POST'));
 assert.equal(calls.some(c=>['/cdn-cgi/access/logout','/oauth2/sign_out'].includes(c.path)),false);
},{compiled:true}));

for(const locale of ['ko-KR','en-US'])test('LOGOUT response loss remains local and explicit retry finishes '+locale,()=>fixture(async f=>{
 const {page}=f;let attempts=0;const global=[];page.on('request',r=>{const path=new URL(r.url()).pathname;if(['/cdn-cgi/access/logout','/oauth2/sign_out'].includes(path))global.push(path);});
 await page.route('**/api/session/logout',route=>{attempts++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'SYNTHETIC_PRIVATE'})});});
 await page.locator('#logout').click();await page.waitForFunction(()=>document.querySelector('#logout').disabled===false);
 assert.ok(page.url().endsWith('/settings'));assert.match(await page.locator('#error').textContent(),locale.startsWith('ko')?/로그아웃을 확인하지 못/:/could not be confirmed/);assert.equal(await page.locator('#load').isDisabled(),true);assert.doesNotMatch(await page.locator('body').textContent(),/SYNTHETIC_PRIVATE/);assert.equal(attempts,1);assert.deepEqual(global,[]);
 await page.unroute('**/api/session/logout');await page.locator('#logout').click();await page.waitForURL('**/signed-out');assert.deepEqual(global,[]);
},{locale}));

for(const locale of ['ko-KR','en-US'])for(const failure of ['503','401','network','json'])test('BOOTSTRAP compiled UI explicit recovery '+locale+' '+failure,()=>fixture(async f=>{
 const {page}=f;let starts=0,ends=0;const paths=[];page.on('request',r=>paths.push(new URL(r.url()).pathname));
 await page.route('**/api/session/start',route=>{starts++;if(starts>1)return route.fallback();if(failure==='network')return route.abort();return route.fulfill({status:failure==='json'?200:Number(failure),contentType:'application/json',body:failure==='json'?'SYNTHETIC_PRIVATE':JSON.stringify({error:'SYNTHETIC_PRIVATE'})});});
 await page.route('**/api/session/logout',route=>{ends++;return route.fallback();});
 await page.reload();await page.locator('#sign-in').waitFor({state:'visible'});assert.equal(starts,1);assert.doesNotMatch(await page.locator('#error').textContent(),/SYNTHETIC_PRIVATE/);
 await page.locator('#sign-in').click();await page.waitForFunction(()=>document.querySelector('#connection').classList.contains('connected'));assert.equal(starts,2);assert.equal(ends,1);assert.equal(await page.locator('#sign-in').isVisible(),false);assert.equal(paths.some(p=>['/cdn-cgi/access/logout','/oauth2/sign_out'].includes(p)),false);
},{locale,compiled:true}));

for(const locale of ['ko-KR','en-US'])test(`CLI-LOGIN ${browserName} ${locale} explains fixed reasons without exposing arbitrary details`,async()=>fixture(async f=>{
 const {page}=f;
 const expected={unsafe_path:locale==='ko-KR'?/소유권.*쓰기 권한.*실행하지 않았/:/ownership.*write permissions.*not executed/,invalid_installation:locale==='ko-KR'?/설치.*무결성/:/installation.*integrity/,timeout:locale==='ko-KR'?/시간.*초과/:/timed out/,output_limit:locale==='ko-KR'?/출력.*한도/:/output.*limit/,unexpected_response:locale==='ko-KR'?/응답.*판독/:/response.*recognized/,check_failed:locale==='ko-KR'?/SSH.*검사/:/SSH.*check/};
 for(const [reason,pattern] of Object.entries(expected)){
  f.setLoginResult({state:'unavailable',reason,error:'SYNTHETIC_PRIVATE'});await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.match(await page.locator('#cli-login-state').textContent(),pattern);assert.doesNotMatch(await f.panel.textContent(),/SYNTHETIC_PRIVATE/);
 }
 for(const reason of ['SYNTHETIC_PRIVATE /unsafe/path','__proto__',{},null]){
  f.setLoginResult({state:'unavailable',reason});await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.doesNotMatch(await f.panel.textContent(),/SYNTHETIC_PRIVATE|unsafe_path|object Object/);
 }
 f.setLoginResult({state:'signed_in',reason:'unsafe_path'});await page.locator('#cli-login-check').click();await page.waitForFunction(()=>document.querySelector('#agent-cli-settings').getAttribute('aria-busy')==='false');assert.doesNotMatch(await page.locator('#cli-login-state').textContent(),/로그인됨|Signed in/);
 assert.equal(f.posts.every(p=>p.path.endsWith('/login-status')),true);
},{locale}));
