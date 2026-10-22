import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentCliState} from '../src/adapters/storage/agent-cli-state.mjs';
import {AGENT_CLI_CONTRACT} from '../src/domain/agent-cli.mjs';

const binding={targetId:'alpha',targetRevision:'a'.repeat(64),profile:'alpha-write',provider:'codex'};
const identifier=n=>n.toString(16).padStart(48,'0');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'cli-history-')),state=createAgentCliState(root);
 t.after(async()=>{state.close();assert.ok(root.startsWith(join(tmpdir(),'cli-history-')));await rm(root,{recursive:true,force:true});});
 const insert=(n,changes={})=>{const b={...binding,...changes},job={id:identifier(n),kind:'command',state:'completed',createdAt:changes.createdAt??1000,profile:b.profile,command:'SYNTHETIC_PRIVATE',operation:{kind:'command',command:'SYNTHETIC_PRIVATE',agentCliContract:AGENT_CLI_CONTRACT,agentCliTargetId:b.targetId,agentCliTargetRevision:b.targetRevision,agentCliProfile:b.profile,agentCliProvider:b.provider}};state.insert(job,'agent-cli:history-request-'+String(n).padStart(8,'0'),'b'.repeat(64));return job;};
 return {root,state,insert};
}
test('CLI-HISTORY journal exposes only current-binding public metadata and never writes on read',async t=>{
 const f=await fixture(t);f.insert(1);f.insert(2,{provider:'claude'});f.insert(3,{targetId:'beta'});f.insert(4,{targetRevision:'c'.repeat(64)});f.insert(5,{profile:'other-write'});
 const before=await readFile(join(f.root,'agent-cli.sqlite'));
 assert.equal(typeof f.state.history,'function','persisted CLI history is available without a browser hint');
 const value=f.state.history(binding);
 assert.deepEqual(value,{requests:[{id:identifier(1),state:'completed',createdAt:1000}],next:null});
 assert.doesNotMatch(JSON.stringify(value),/SYNTHETIC_PRIVATE|command|request_key|digest|source|remote_status/);
 assert.deepEqual(await readFile(join(f.root,'agent-cli.sqlite')),before);
});
test('CLI-HISTORY journal keyset pages include older requests once despite newer arrivals and tied timestamps',async t=>{
 const f=await fixture(t);for(let n=1;n<=41;n++)f.insert(n);
 assert.equal(typeof f.state.history,'function','bounded persisted history supports stable paging');
 const first=f.state.history(binding);assert.equal(first.requests.length,20);assert.deepEqual(first.requests.map(x=>x.id),Array.from({length:20},(_,i)=>identifier(41-i)));
 assert.deepEqual(first.next,{before:1000,beforeId:identifier(22)});f.insert(99,{createdAt:2000});
 const second=f.state.history(binding,first.next);assert.deepEqual(second.requests.map(x=>x.id),Array.from({length:20},(_,i)=>identifier(21-i)));
 const third=f.state.history(binding,second.next);assert.deepEqual(third,{requests:[{id:identifier(1),state:'completed',createdAt:1000}],next:null});
 assert.equal(new Set([...first.requests,...second.requests,...third.requests].map(x=>x.id)).size,41);
});
test('CLI-HISTORY journal rejects malformed cursors and returns no records for another current scope',async t=>{
 const f=await fixture(t);f.insert(1);
 assert.equal(typeof f.state.history,'function','history cursor validation is part of the public journal boundary');
 for(const cursor of [{before:1000},{beforeId:identifier(1)},{before:NaN,beforeId:identifier(1)},{before:1000,beforeId:'bad'},{before:'1000',beforeId:identifier(1)},{before:1000,beforeId:identifier(1),extra:true}])assert.throws(()=>f.state.history(binding,cursor));
 assert.deepEqual(f.state.history({...binding,provider:'claude'}),{requests:[],next:null});
});
