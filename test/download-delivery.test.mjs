import test from 'node:test';
import assert from 'node:assert/strict';
import {createCardController} from '../ui/src/controller.js';

function fixture({login=false,hostFails=false,browserFails=false}={}) {
  const events=[],errors=[],notices=[];let sequence=0,live=true;
  const context={job:{id:'fixture-download',kind:'download',state:'completed'},meta:{uiEnabled:true,viewTicket:'synthetic-view',namespace:'fixture_',downloadRequiresLogin:login}};
  const state={busy:false,capture:()=>context,current:()=>live,mergeMeta:(_c,meta)=>Object.assign(context.meta,meta)};
  const host={async call(name,args){events.push({name,id:args.id});if(name==='show-approval')return {_meta:{sshApproval:{viewTicket:'synthetic-renewed'}}};assert.equal(name,'ui-download-link');return {_meta:{sshApproval:{downloadUrl:'https://fixture.test/download/'+ ++sequence,fileName:'fixture.txt'}}};},
    async downloadFile(){events.push({name:'host-save'});return {isError:hostFails};},async openLink({url}){events.push({name:'browser-save',url});return {isError:browserFails};}};
  const controller=createCardController({state,host,document:{},view:{t:s=>s,setBusy(){},error:s=>{if(s)errors.push(s);},downloadStatus:s=>notices.push(s)}});
  return {save:()=>controller.save(context),events,errors,notices,retire:()=>{live=false;}};
}

test('authenticated downloads open the user browser without a host fetch or a claim of device receipt',async()=>{
  const f=fixture({login:true});await f.save();
  assert.deepEqual(f.events.map(e=>e.name),['show-approval','ui-download-link','browser-save']);
  assert.match(f.notices[0],/로그인 후/);assert.match(f.notices[0],/기기에서 확인/);assert.deepEqual(f.errors,[]);
});

test('unsupported host save renews the possibly consumed link, then opens the browser once',async()=>{
  const f=fixture({hostFails:true});await f.save();
  assert.deepEqual(f.events.map(e=>e.name),['show-approval','ui-download-link','host-save','ui-download-link','browser-save']);
  assert.equal(f.events.at(-1).url,'https://fixture.test/download/2');assert.deepEqual(f.errors,[]);
  assert.ok(f.events.filter(e=>e.id).every(e=>e.id==='fixture-download'));
});

test('a rejected browser save reports a manual next step and never requests another SSH operation',async()=>{
  const f=fixture({login:true,browserFails:true});await f.save();
  assert.match(f.errors[0],/웹 승인 화면/);assert.equal(f.events.length,3);assert.equal(f.notices.length,0);
});

test('an obsolete card cannot save another file',async()=>{
  const f=fixture();f.retire();await f.save();assert.deepEqual(f.events,[]);
});
