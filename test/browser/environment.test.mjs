import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {launchBrowser} from './browser.mjs';
import { createApplication } from '../../app.mjs';

async function fixture(run, { width = 1280, available = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'env-browser-')); let browser;
  const state = { revision:'a'.repeat(64), available, pendingRestart:false, restart:{state:'idle'}, readOnlyKeys:['BRIDGE_ADMIN_TOKEN','BRIDGE_MCP_PORT'],
    fields:[{key:'BRIDGE_DISPLAY_NAME',label:'중계기 표시 이름',type:'text',value:'테스트 서버'}, {key:'BRIDGE_JEV_ENABLED',label:'Jev 평가 사용',type:'boolean',value:'false'}, {key:'JEV_API_KEY',label:'Jev API 키',type:'secret',configured:true}] };
  const posts=[]; let failSave=false, dropRestart=false;
  const app=await createApplication({ transferRoot:root, uiHtml:'', audit:()=>{},
    env:{BRIDGE_MCP_TOKEN:'synthetic-mcp',BRIDGE_ADMIN_TOKEN:'synthetic-owner',BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_UI_TICKET_KEY:'a'.repeat(64)},
    registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'synthetic',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},
    classify:()=>({class:'privileged'}),executeCommand:async()=>({texts:[]}),
    environmentTransport:async request=>{
      if(!state.available)throw Error('synthetic unavailable');
      if(request.action==='read')return structuredClone(state);
      posts.push(request);
      if(request.action==='save') {
        if(failSave)return {error:'conflict'};
        for(const field of state.fields)if(Object.hasOwn(request.changes,field.key)) {
          if(field.type==='secret')field.configured=request.changes[field.key]!==null;
          else field.value=request.changes[field.key]??'';
        }
        state.revision='b'.repeat(64);state.pendingRestart=true;return structuredClone(state);
      }
      state.restart={id:'c'.repeat(32),state:'healthy'};state.pendingRestart=false;
      if(dropRestart)throw Error('synthetic connection lost');
      return {accepted:true,restart:{id:state.restart.id,state:'scheduled'}};
    }
  });
  try {
    await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+app.adminHttp.address().port;
    browser=await launchBrowser();
    const context=await browser.newContext({locale:'ko-KR',viewport:{width,height:900}});
    await context.route('**/*',async route=>{
      const request=route.request(); if(!request.url().startsWith(origin+'/'))return route.abort();
      if(request.method()==='POST') {
        const response=await route.fetch({maxRedirects:0,headers:{...request.headers(),origin:'https://owner.test'}});
        return route.fulfill({response});
      }
      return route.continue();
    });
    const page=await context.newPage(); page.setDefaultTimeout(7000);
    const pageErrors=[]; page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(origin+'/settings');
    await page.getByPlaceholder('관리자 토큰').fill('synthetic-owner'); await page.getByRole('button',{name:'요청 조회',exact:true}).click();
    try { await page.locator('#env-JEV_API_KEY').waitFor(); }
    catch(error) { throw Error(JSON.stringify({browserErrors:pageErrors,body:(await page.locator('body').innerText()).slice(-2500),cause:error.message})); }
    await run({page,posts,state,addPending:()=>app.queue.submit('synthetic-pending'),setFailSave:value=>failSave=value,setDropRestart:value=>dropRestart=value});
  } finally {await browser?.close();await app.close();await rm(root,{recursive:true});}
}

test('ENV browser edits fields, masks existing key, preserves blank secret and confirms save/restart',async()=>fixture(async({page,posts})=>{
  const panel=page.locator('#environment-editor');
  assert.equal(await page.locator('#env-JEV_API_KEY').getAttribute('type'),'password');
  assert.equal(await page.locator('#env-JEV_API_KEY').inputValue(),'');
  assert.equal(await panel.getByRole('button',{name:'ENV 저장',exact:true}).isEnabled(),false);
  await page.locator('#env-BRIDGE_DISPLAY_NAME').fill('바뀐 서버');
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  assert.equal(await panel.getByRole('button',{name:'서비스 재시작',exact:true}).isEnabled(),false);
  await panel.getByRole('button',{name:'ENV 저장',exact:true}).click();
  await page.getByText(/ENV 저장 완료/).waitFor();
  assert.deepEqual(posts[0].changes,{BRIDGE_DISPLAY_NAME:'바뀐 서버'});
  assert.equal(await page.locator('#env-JEV_API_KEY').inputValue(),'');
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  await panel.getByRole('button',{name:'서비스 재시작',exact:true}).click();
  await page.getByText(/재시작 완료 · health 정상/).waitFor();
  assert.equal(posts.filter(p=>p.action==='restart').length,1);
  if(process.env.ENV_SCREENSHOT) await page.screenshot({path:process.env.ENV_SCREENSHOT,fullPage:true});
}));

test('ENV browser secret replacement/unset, conflict keeps draft, responsive width',async()=>fixture(async({page,posts,setFailSave})=>{
  const panel=page.locator('#environment-editor'),key=page.locator('#env-JEV_API_KEY');
  await key.fill('synthetic-new-key');
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  setFailSave(true); await panel.getByRole('button',{name:'ENV 저장',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:/変更|변경됐습니다/}).waitFor();
  assert.equal(await key.inputValue(),'synthetic-new-key');
  assert.equal(await panel.getByRole('button',{name:'서비스 재시작',exact:true}).isEnabled(),false);
  assert.equal(posts.length,1);
  await panel.getByRole('button',{name:'ENV 불러오기',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#env-JEV_API_KEY').value==='');
  setFailSave(false);
  await panel.getByRole('checkbox',{name:'Jev API 키 설정 해제 (기본값 사용)',exact:true}).check();
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  await panel.getByRole('button',{name:'ENV 저장',exact:true}).click();await page.getByText(/ENV 저장 완료/).waitFor();
  assert.deepEqual(posts.at(-1).changes,{JEV_API_KEY:null});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
},{width:390}));

test('ENV browser lost restart reply reconciles by GET without another restart POST',async()=>fixture(async({page,posts,setDropRestart})=>{
  setDropRestart(true); const panel=page.locator('#environment-editor');
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  await panel.getByRole('button',{name:'서비스 재시작',exact:true}).click();
  await page.getByText(/재시작 완료 · health 정상/).waitFor();
  assert.equal(posts.filter(p=>p.action==='restart').length,1);
}));

test('ENV browser explains pending-request refusal immediately without restarting',async()=>fixture(async({page,posts,addPending})=>{
  addPending(); const panel=page.locator('#environment-editor');
  await panel.getByRole('checkbox',{name:/변경 내용을 확인했습니다/}).check();
  await panel.getByRole('button',{name:'서비스 재시작',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:/승인 대기/}).waitFor();
  assert.equal(posts.filter(p=>p.action==='restart').length,0);
}));
