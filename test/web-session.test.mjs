import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWebController } from '../web/src/controller.js';
import { createWebState } from '../web/src/state.js';
import { createWebView } from '../web/src/view.js';
import { createWebApi } from '../web/src/http.js';
import { createWebI18n } from '../web/src/i18n.js';
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
function harness(language, access = false, jobs) {
  class Node {
    constructor(tag) { this.tag=tag;this.children=[];this.dataset={};this.value='';this.validity={badInput:false};this.classList={add(){},remove(){}}; }
    append(node) { this.insertBefore(node,null); }
    insertBefore(node,before) {
      node.remove(); const at=before===null?this.children.length:this.children.indexOf(before);
      assert.ok(at>=0,'DOM insertion anchor must belong to this parent');
      node.parent=this;this.children.splice(at,0,node);
    }
    replaceChildren(...nodes) { for(const node of [...this.children])node.remove();for(const node of nodes)this.append(node); }
    get firstChild() { return this.children[0]??null; }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this)+1]??null; }
    querySelectorAll(selector) {
      const descendants=this.children.flatMap(node=>[node,...node.querySelectorAll('*')]);
      return selector==='*'?descendants:descendants.filter(node=>selector==='button'?node.tag==='button':selector==='details[open]'?node.tag==='details'&&node.open:false);
    }
    addEventListener(type, fn) { this[type]=fn; }
    setAttribute(name,value) { this[name]=value; }
    before(node) { if(this.parent)this.parent.insertBefore(node,this); }
    removeAttribute() {}
    get childElementCount() { return this.children.length; }
    remove() { if(this.parent){this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null;} }
  }
  const roots=Object.fromEntries(['token','load','logout','error','history','jobs','running','running-count','pending-count','history-count','connection','connection-text','updated','auth-label','auth-note','sign-in'].map(id=>[id,new Node('root')]));
  const logout=html.match(/<button id="logout"[^>]*data-en="([^"]+)"[^>]*>([^<]+)<\/button>/);
  assert.ok(logout, 'Logout must be a native keyboard-accessible button in the actual HTML');
  roots.logout.hidden=true;roots.logout.dataset.en=logout[1];roots.logout.textContent=logout[2];
  const document={hidden:false,body:{dataset:{authMode:access?'access':'token'}},documentElement:{},querySelectorAll:()=>[roots.logout],getElementById:id=>roots[id],createElement:tag=>new Node(tag)};
  const timers=[],requests=[],navigations=[],cleared=[];
  let deferredGet, deferredPost;
  const payload=jobs??[{id:'1'.repeat(48),kind:'command',state:'pending',target:'fixture@localhost',command:'echo 한글 원문',expiresAt:1800000000000}];
  const i18n=createWebI18n(language),state=createWebState(access),view=createWebView({document,i18n});
  const api=createWebApi({accessMode:access,getToken:view.token,isSignedOut:()=>state.signedOut,unauthorized:view.unauthorized,t:i18n.t,fetch:async(path,opts)=>{
    requests.push({path,method:opts.method,headers:opts.headers,credentials:opts.credentials});if(path.startsWith('/api/session/'))return {ok:true,json:async()=>({connected:path.endsWith('/start')})};if(opts.method==='POST')payload[0].state=path.endsWith('/deny')?'denied':'completed';
    const value=path==='/api/requests'?JSON.parse(JSON.stringify(payload)):path.endsWith('/download')?{downloadUrl:'/downloads/fixture'}:{state:payload[0].state};
    if(opts.method==='GET' && deferredGet){const next=deferredGet;deferredGet=null;await next.promise;}
    if(opts.method==='POST' && deferredPost){const next=deferredPost;deferredPost=null;await next.promise;}
    return {ok:true,json:async()=>value};
  }});
  const controller=createWebController({state,view,api,document,location:{assign:path=>navigations.push(path),replace:path=>navigations.push(path)},timers:{clearInterval:id=>cleared.push(id),setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length}}});
  controller.start();
  return {roots,document,timers,requests,navigations,cleared,payload,controller,deferNextGet(){let release;deferredGet={promise:new Promise(resolve=>release=resolve)};return release;},deferNextPost(){let release;deferredPost={promise:new Promise(resolve=>release=resolve)};return release;},allText(node){return [node.textContent??'',...node.children.map(n=>this.allText(n))].join('\n')}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('GET deadline and supersession settle even if transport ignores abort; POST remains single and untimed',async()=>{
  const calls=[];let release;
  const api=createWebApi({fetch:async(path,options)=>{calls.push(options);return new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({ok:true})}));},accessMode:true,isSignedOut:()=>false,unauthorized:()=>{},t:s=>s});
  const controller=new AbortController(),pending=api('/read','GET',undefined,{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(calls[0].signal.aborted,true);release();
  await assert.rejects(api('/read','GET',undefined,{timeoutMs:5}),{name:'TimeoutError'});release();
  let complete=false;const post=api('/write','POST',{}, {timeoutMs:1}).then(()=>complete=true);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(complete,false);assert.equal(calls[2].signal,undefined);assert.equal(calls.length,3);release();await post;
});

test('initial/transient read failures recover by polling, authorization denial stops it and POST is never retried',async()=>{
  let count=0,posts=0;const renders=[],errors=[],cleared=[],ticks=[];
  const state=createWebState(true),view={target:()=>undefined,selectionRevision:()=>0,initialize(){},loading(){},render:v=>renders.push(v),connected(){},disconnected(){},error:e=>errors.push(e),deciding(){}};
  const api=async(path,method='GET')=>{if(method==='POST'){posts++;throw Error('response lost');}count++;if([1,3].includes(count))throw Object.assign(Error('temporary'),{status:503});if(count===5)throw Object.assign(Error('denied'),{status:403});return[count];};
  const c=createWebController({state,view,api,document:{hidden:false},location:{},timers:{setInterval:fn=>{ticks.push(fn);return ticks.length;},clearInterval:id=>cleared.push(id)}});
  await c.load();assert.equal(ticks.length,1);assert.notEqual(state.polling,null,'initial transient failure keeps read recovery scheduled');await ticks[0]();await settle();assert.deepEqual(renders,[[2]]);
  await c.load();assert.notEqual(state.polling,null,'polling transient failure keeps read recovery scheduled');await ticks[0]();await settle();assert.deepEqual(renders,[[2],[4]]);
  await c.decide('fixed-request','approve');assert.equal(posts,1);
  assert.ok(cleared.includes(1));assert.equal(state.polling,null);assert.equal(count,5,'lost decision response triggers one reconciliation read');assert.equal(c.reloadState().blocked,true);
});

test('lost approval observation keeps unknown state until the fixed request is reconciled',async()=>{
  let posts=0,jobState='pending';const state=createWebState(true);
  const view={target:()=>undefined,selectionRevision:()=>0,initialize(){},loading(){},render(){},connected(){},disconnected(){},error(){},deciding(){}};
  const api=async(path,method='GET')=>{if(method==='POST'){posts++;throw Error('accepted response lost');}return[{id:'fixed',state:jobState}];};
  const c=createWebController({state,view,api,document:{hidden:false},location:{},timers:{setInterval:()=>1,clearInterval(){}}});
  await c.decide('fixed','approve');assert.equal(c.reloadState().blocked,true,'unreconciled approval blocks reload');
  await c.decide('fixed','approve');assert.equal(posts,1,'unknown approval never replays POST');await c.load(true);assert.equal(c.reloadState().blocked,true);
  jobState='running';await c.load(true);assert.equal(c.reloadState().blocked,false);assert.equal(posts,1);
});
test('English web labels, ten-second automatic timer and immediate manual/action refresh',async()=>{
  const h=harness('en-US');await h.roots.load.onclick();
  assert.equal(h.timers[0].ms,10000);
  assert.equal(h.roots['connection-text'].textContent,'Administrator connected');assert.match(h.roots.updated.textContent,/Refreshes every 10 seconds/);
  assert.match(h.allText(h.roots.jobs),/Approve and run/);assert.match(h.allText(h.roots.jobs),/echo 한글 원문/);
  const before=h.requests.length;await h.roots.load.onclick();assert.equal(h.requests.length,before+1);
  const button=h.roots.jobs.children[0].children.find(x=>x.className==='actions').children[0];await button.onclick();
  assert.deepEqual(h.requests.slice(-2).map(x=>x.method),['POST','GET']);
  h.document.hidden=true;const count=h.requests.length;h.timers[0].fn();assert.equal(h.requests.length,count);
});
test('Korean browser language preserves Korean UI; other locales fall back to English',async()=>{
  for(const [lang,expected] of [['ko-KR','관리자 연결됨'],['ko','관리자 연결됨'],['de-DE','Administrator connected']]){
    const h=harness(lang);await h.roots.load.onclick();assert.equal(h.roots['connection-text'].textContent,expected);
    assert.match(h.allText(h.roots.jobs),/echo 한글 원문/);
  }
});
test('decision refresh survives an in-flight automatic GET without waiting for the next ten-second tick',async()=>{
  for(const action of ['approve','deny']){
    const h=harness('en-US');await h.roots.load.onclick();
    const button=h.roots.jobs.children[0].children.find(x=>x.className==='actions').children[action==='approve'?0:1];
    const release=h.deferNextGet();h.timers[0].fn();await settle();
    const decision=button.onclick();await settle();
    assert.equal(h.requests.length,4,'forced refresh cancels the previous read without waiting');
    release();await decision;await settle();
    assert.deepEqual(h.requests.map(x=>x.method),['GET','GET','POST','GET']);
    assert.equal(h.roots['pending-count'].textContent,0);
    assert.match(h.allText(h.roots.history),action==='approve'?/Completed/:/Denied/);
  }
});
test('manual Enter refresh is preserved behind an in-flight automatic GET',async()=>{
  const h=harness('en-US');await h.roots.load.onclick();
  const release=h.deferNextGet();h.timers[0].fn();await settle();
  h.roots.token.keydown({key:'Enter'});release();await settle();
  assert.deepEqual(h.requests.map(x=>x.method),['GET','GET','GET']);
});
test('Access browser connects automatically, hides token input and sends no bearer credential',async()=>{
  for(const lang of ['ko-KR','en-US']){
    const h=harness(lang,true);await settle();
    assert.equal(h.roots.token.hidden,true);assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].headers.Authorization,undefined);assert.equal(h.requests[0].credentials,'same-origin');
    assert.equal(h.timers[0].ms,10000);assert.match(h.roots['auth-label'].textContent,lang==='ko-KR'?/본인/:/account/);
  }
});
test('Access logout is localized, clears requests, stops polling and navigates without credentials',async()=>{
  for(const [lang,label] of [['ko-KR','로그아웃'],['en-US','Sign out']]){
    const h=harness(lang,true);await settle();
    assert.equal(h.roots.logout.hidden,false);assert.equal(h.roots.logout.textContent,label);
    const release=h.deferNextGet();h.timers[0].fn();await settle();
    const before=h.requests.length;await h.roots.logout.onclick();
    assert.deepEqual(h.navigations,['/signed-out']);assert.ok(h.cleared.includes(1));
    release();await settle();await h.roots.load.onclick();h.timers[0].fn();await settle();
    assert.equal(h.requests.length,before+1,'Only the explicit local session logout request is sent; no polling or refresh');
    assert.equal(h.roots.jobs.children.length,0,'Delayed GET cannot restore sensitive requests');
    assert.equal(h.roots.history.children.length,0);assert.equal(h.roots['pending-count'].textContent,'0');
    assert.equal(h.roots.load.disabled,true);
  }
});
test('token logout forgets the entered credential and resets the page without revoking server tokens',async()=>{
  const h=harness('en-US');assert.equal(h.roots.logout.hidden,true);
  h.roots.token.value='synthetic-only-token';await h.roots.load.onclick();
  assert.equal(h.roots.logout.hidden,false);
  const before=h.requests.length;h.roots.logout.onclick();await h.roots.load.onclick();
  assert.equal(h.roots.token.value,'');assert.deepEqual(h.navigations,['/']);
  assert.equal(h.requests.length,before);assert.equal(h.roots.jobs.children.length,0);
});
test('late download POST cannot navigate away from logout or restore requests',async()=>{
  for(const access of [true,false]){
    const h=harness('en-US',access,[{id:'2'.repeat(48),kind:'download',state:'completed',target:'fixture@localhost',operation:{remotePath:'/tmp/fixture.bin'},createdAt:1800000000000}]);
    if(access)await settle();else await h.roots.load.onclick();
    const body=h.roots.history.children[0].children.find(x=>x.className==='history-body');
    const button=body.children.find(x=>x.className==='actions').children[0];
    const release=h.deferNextPost();const saving=button.onclick();await settle();
    const before=h.requests.length;h.roots.logout.onclick();release();await saving;await settle();
    assert.deepEqual(h.navigations,[access?'/signed-out':'/']);
    h.timers[0].fn();await settle();assert.equal(h.requests.length,before+(access?1:0));
    assert.equal(h.roots.history.children.length,0);assert.equal(h.roots.jobs.children.length,0);
  }
});

test('unrelated request changes preserve existing nodes, expanded history and output state',async()=>{
  const h=harness('en-US',false,[
    {id:'1'.repeat(48),kind:'command',state:'pending',target:'fixture',command:'unchanged command',expiresAt:1800000000000},
    {id:'2'.repeat(48),kind:'command',state:'completed',target:'fixture',command:'history command',createdAt:1800000000000,result:{content:[{type:'text',text:'unchanged output'}]}},
  ]);
  await h.controller.load();
  const pending=h.roots.jobs.children[0],history=h.roots.history.children[0];history.open=true;
  const output=history.children.find(x=>x.className==='history-body').children.find(x=>x.className==='output');output.scrollTop=42;
  await h.controller.load();
  assert.equal(h.roots.jobs.children[0],pending);assert.equal(h.roots.history.children[0],history);
  h.payload.push({id:'3'.repeat(48),kind:'command',state:'running',target:'fixture',command:'unrelated change',createdAt:1800000000000});
  await h.controller.load();
  assert.equal(h.roots.jobs.children[0],pending,'unrelated arrival must not replace the pending button subtree');
  assert.equal(h.roots.history.children[0],history,'running arrivals do not detach existing terminal history');
  assert.match(h.allText(h.roots.running),/unrelated change/);
  assert.equal(history.open,true);assert.equal(output.scrollTop,42);
});

test('administrator logout waits for bootstrap and never sends a global logout request',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),calls=[];
 const api=createWebApi({accessMode:true,getToken:()=>'',isSignedOut:()=>false,unauthorized(){},t:v=>v,fetch:async(path)=>{calls.push(path);if(path.endsWith('/start'))await gate;return{ok:true,json:async()=>({connected:path.endsWith('/start')})};}});
 const begin=api.beginAdminSession(),end=api.endAdminSession();assert.deepEqual(calls,['/api/session/start']);release();await begin;await end;assert.deepEqual(calls,['/api/session/start','/api/session/logout']);
});
test('administrator logout response loss stays unconfirmed until explicit idempotent retry',async()=>{
 const state=createWebState(true),navigations=[],errors=[];let attempts=0,retries=0;
 const api=async()=>[];api.endAdminSession=async()=>{if(++attempts===1)throw Error('SYNTHETIC_PRIVATE');};
 const view={initialize(){},signedOut(){},error:s=>errors.push(s),logoutRetry(){retries++;}};
 const controller=createWebController({state,view,api,document:{body:{dataset:{}}},location:{replace:p=>navigations.push(p)},timers:{clearInterval(){}}});
 await controller.logout();assert.equal(state.signedOut,true);assert.deepEqual(navigations,[]);assert.equal(retries,1);assert.ok(!errors.join('').includes('SYNTHETIC_PRIVATE'));
 await controller.logout();assert.deepEqual(navigations,['/signed-out']);assert.equal(attempts,2);
});

for(const failure of ['http','network','json'])test('bootstrap '+failure+' failure exposes explicit administrator reconnect',async()=>{
 let shown=0;const calls=[];
 const api=createWebApi({accessMode:true,isSignedOut:()=>false,unauthorized:()=>shown++,t:v=>v,fetch:async path=>{calls.push(path);if(path.endsWith('/logout'))return{ok:true,json:async()=>({connected:false})};if(failure==='network')throw Error('SYNTHETIC_PRIVATE');return{ok:failure!=='http',status:503,json:async()=>{throw Error('SYNTHETIC_PRIVATE');}};}});
 await assert.rejects(api.beginAdminSession(),error=>!error.message.includes('SYNTHETIC_PRIVATE'));assert.equal(shown,1);
 await assert.rejects(api('/api/requests'));assert.deepEqual(calls,['/api/session/start'],'failed bootstrap never silently retries');
 const state=createWebState(true),navigations=[];let actions;
 const controller=createWebController({state,api,view:{initialize:a=>actions=a},document:{body:{dataset:{}}},location:{replace:p=>navigations.push(p)},timers:{}});
 // The reconnect action is available without issuing an ordinary protected read.
 await controller.reconnect();assert.deepEqual(calls,['/api/session/start','/api/session/logout']);assert.deepEqual(navigations,['/']);
});
