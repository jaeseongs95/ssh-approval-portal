import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
function harness(language, access = false, jobs) {
  class Node {
    constructor(tag) { this.tag=tag;this.children=[];this.dataset={};this.value='';this.classList={add(){},remove(){}}; }
    append(node) { node.parent=this;this.children.push(node); }
    replaceChildren(...nodes) { this.children=nodes; }
    querySelectorAll() { return []; }
    addEventListener(type, fn) { this[type]=fn; }
    removeAttribute() {}
    get childElementCount() { return this.children.length; }
    remove() { this.parent.children=this.parent.children.filter(x=>x!==this); }
  }
  const roots=Object.fromEntries(['token','load','logout','error','history','jobs','pending-count','history-count','connection','connection-text','updated','auth-label','auth-note','sign-in'].map(id=>[id,new Node('root')]));
  const logout=html.match(/<button id="logout"[^>]*data-en="([^"]+)"[^>]*>([^<]+)<\/button>/);
  assert.ok(logout, 'Logout must be a native keyboard-accessible button in the actual HTML');
  roots.logout.hidden=true;roots.logout.dataset.en=logout[1];roots.logout.textContent=logout[2];
  const document={hidden:false,body:{dataset:{authMode:access?'access':'token'}},documentElement:{},querySelectorAll:()=>[roots.logout],getElementById:id=>roots[id],createElement:tag=>new Node(tag)};
  const timers=[],requests=[],navigations=[],cleared=[];
  let deferredGet, deferredPost;
  const payload=jobs??[{id:'1'.repeat(48),kind:'command',state:'pending',target:'fixture@localhost',command:'echo 한글 원문',expiresAt:1800000000000}];
  runInNewContext(source,{document,navigator:{language},console,Date,JSON,location:{assign:path=>navigations.push(path),replace:path=>navigations.push(path)},clearInterval:id=>cleared.push(id),setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length},fetch:async(path,opts)=>{
    requests.push({path,method:opts.method,headers:opts.headers,credentials:opts.credentials});if(opts.method==='POST')payload[0].state=path.endsWith('/deny')?'denied':'completed';
    const value=path==='/api/requests'?JSON.parse(JSON.stringify(payload)):path.endsWith('/download')?{downloadUrl:'/downloads/fixture'}:{state:payload[0].state};
    if(opts.method==='GET' && deferredGet){const next=deferredGet;deferredGet=null;await next.promise;}
    if(opts.method==='POST' && deferredPost){const next=deferredPost;deferredPost=null;await next.promise;}
    return {ok:true,json:async()=>value};
  }});
  return {roots,document,timers,requests,navigations,cleared,deferNextGet(){let release;deferredGet={promise:new Promise(resolve=>release=resolve)};return release;},deferNextPost(){let release;deferredPost={promise:new Promise(resolve=>release=resolve)};return release;},allText(node){return [node.textContent??'',...node.children.map(n=>this.allText(n))].join('\n')}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('English web labels, ten-second automatic timer and immediate manual/action refresh',async()=>{
  const h=harness('en-US');await h.roots.load.onclick();
  assert.equal(h.timers[0].ms,10000);
  assert.equal(h.roots['connection-text'].textContent,'Connected');assert.match(h.roots.updated.textContent,/Refreshes every 10 seconds/);
  assert.match(h.allText(h.roots.jobs),/Approve and run/);assert.match(h.allText(h.roots.jobs),/echo 한글 원문/);
  const before=h.requests.length;await h.roots.load.onclick();assert.equal(h.requests.length,before+1);
  const button=h.roots.jobs.children[0].children.find(x=>x.className==='actions').children[0];await button.onclick();
  assert.deepEqual(h.requests.slice(-2).map(x=>x.method),['POST','GET']);
  h.document.hidden=true;const count=h.requests.length;h.timers[0].fn();assert.equal(h.requests.length,count);
});
test('Korean browser language preserves Korean UI; other locales fall back to English',async()=>{
  for(const [lang,expected] of [['ko-KR','연결됨'],['ko','연결됨'],['de-DE','Connected']]){
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
    assert.equal(h.requests.length,3,'initial GET, automatic GET and decision POST');
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
    const before=h.requests.length;h.roots.logout.onclick();
    assert.deepEqual(h.navigations,['/cdn-cgi/access/logout']);assert.ok(h.cleared.includes(1));
    release();await settle();await h.roots.load.onclick();h.timers[0].fn();await settle();
    assert.equal(h.requests.length,before,'No post-logout polling or refresh');
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
    assert.deepEqual(h.navigations,[access?'/cdn-cgi/access/logout':'/']);
    h.timers[0].fn();await settle();assert.equal(h.requests.length,before);
    assert.equal(h.roots.history.children.length,0);assert.equal(h.roots.jobs.children.length,0);
  }
});
