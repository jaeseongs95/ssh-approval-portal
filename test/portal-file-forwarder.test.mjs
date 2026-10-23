import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFileForwarder, validateFileManifest } from '../src/adapters/cli/file-forwarder.mjs';
import { saveDownload } from '../src/adapters/cli/local-files.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'), capId='a'.repeat(48), transferId='b'.repeat(48), requestId='c'.repeat(48), revision='d'.repeat(64), artifactId='e'.repeat(48);
async function fixture(t,{direction='upload',bytes=Buffer.from([0,255,19]),lose,afterSave}={}){
 const root=await mkdtemp(join(tmpdir(),'opaque-forwarder-')),journal=join(root,'journal');
 await mkdir(journal,{mode:0o700});t.after(async()=>{assert.ok(root.startsWith(join(tmpdir(),'opaque-forwarder-')));await rm(root,{recursive:true,force:true});});
 const source=join(root,'PRIVATE-source.bin'),destination=join(root,'PRIVATE-saved.bin');await writeFile(source,bytes);
 const cap={id:capId,publicName:'시험 파일.bin',target:'default',targetRevision:revision,remotePath:'/tmp/PRIVATE-remote.bin',size:bytes.length,sha256:sha(bytes),expiresAt:Date.now()+600000,elevate:false,direction,...(direction==='upload'?{source,overwrite:false}:{destination})};
 const manifest={version:1,origin:'https://fixture.invalid',capabilities:[cap]},counts={open:0,upload:0,download:0,resume:0,save:0,status:0,transfer:0,close:0};
 const operation={kind:direction,remotePath:cap.remotePath,elevate:false,fileTargetId:'default',fileTargetRevision:revision,...(direction==='upload'?{artifactId:transferId,size:cap.size,sha256:cap.sha256,overwrite:false}:{})};
 const job={id:requestId,kind:direction,state:'pending',operation,result:direction==='download'?{structuredContent:{artifactId,fileName:'remote.bin',size:cap.size,sha256:cap.sha256}}:undefined};
 const targets={targets:[{id:cap.target,revision:cap.targetRevision,enabled:true}]};
 const client={
 async targets(){return targets;},
 async upload(path,intent,ack,expected){counts.upload++;assert.equal(path,source);assert.deepEqual(expected,{size:cap.size,sha256:cap.sha256});assert.equal(intent.expectedTargetRevision,revision);
  if(lose==='before-handle')throw Error('PRIVATE-source-and-token-a.b.c');await ack({transferId});if(lose==='after-handle')throw Error('PRIVATE-after-handle');return job;},
 async requestDownload(intent){counts.download++;assert.equal(intent.expectedTargetRevision,revision);return job;},
 async resumeUpload(id,path,intent,expected){counts.resume++;assert.equal(id,transferId);assert.equal(path,source);assert.equal(intent.expectedTargetRevision,revision);assert.equal(expected.sha256,cap.sha256);return job;},
 async status(id){counts.status++;assert.equal(id,requestId);return job;},
 async transfer(id){counts.transfer++;assert.equal(id,transferId);return {transfer:{id,state:'staging',fileTargetBound:true,targetId:'default',targetRevision:revision,remotePath:cap.remotePath,elevate:false,overwrite:false,size:cap.size,sha256:cap.sha256,received:0}};},
 async save(id,path,expected){counts.save++;assert.equal(id,requestId);assert.equal(path,destination);assert.equal(expected.targetRevision,revision);assert.equal(expected.sha256,cap.sha256);
  async function* chunks(){yield bytes;}const saved=await saveDownload(path,expected,chunks());await afterSave?.({journal,cap});return {...saved,requestId};},
 async close(){counts.close++;}
 };
 const factory=async(_origin,options)=>{counts.open++;assert.ok(options.timeoutMs>0);assert.ok(options.signal instanceof AbortSignal);return client;};
 const create=async(value=manifest)=>createFileForwarder({manifest:value,journalRoot:journal,openClient:factory});
 return {root,journal,source,destination,cap,manifest,counts,job,create,api:await create(),bytes,targets};
}
const args={capabilityId:capId};
test('strict human manifest and capability arguments refuse extra authority before helper',async t=>{
 const f=await fixture(t);for(const bad of [{...f.manifest,extra:true},{...f.manifest,capabilities:[{...f.cap,command:'id'}]},{...f.manifest,capabilities:[{...f.cap,targetRevision:'invalid'}]},{...f.manifest,capabilities:[f.cap,f.cap]}])assert.throws(()=>validateFileManifest(bad),{code:'INVALID_FILE_MANIFEST'});
 for(const bad of [{...args,path:f.source},{capabilityId:'z'.repeat(48)},{}])await assert.rejects(f.api.invoke('upload',bad),{code:'INVALID_CAPABILITY_ARGUMENTS'});
 await assert.rejects(f.api.invoke('upload',{capabilityId:'f'.repeat(48)}),{code:'CAPABILITY_UNAVAILABLE'});assert.equal(f.counts.open,0);
 assert.equal(JSON.stringify(f.api.list({})).includes('PRIVATE-'),false);
});
test('exclusive durable initial claim permits one effect across competing instances',async t=>{
 const f=await fixture(t),second=await f.create();const values=await Promise.all([f.api.invoke('upload',args),second.invoke('upload',args)]);
 assert.equal(f.counts.upload,1);assert.ok(values.some(x=>x.requestId===requestId));
 const third=await f.create();assert.equal((await third.invoke('upload',args)).requestId,requestId);assert.equal(f.counts.upload,1);assert.equal(f.counts.open,f.counts.close);
});
test('unknown initial reply survives restart without a replacement request or private errors',async t=>{
 const f=await fixture(t,{lose:'before-handle'});const first=await f.api.invoke('upload',args);assert.equal(first.state,'unknown');assert.equal(JSON.stringify(first).includes('PRIVATE-'),false);
 const next=await f.create();assert.equal((await next.invoke('upload',args)).state,'unknown');assert.equal((await next.invoke('resume-upload',args)).state,'unknown');assert.equal(f.counts.upload,1);assert.equal(f.counts.resume,0);assert.equal(f.counts.open,1);
});
test('known transfer permits only explicit same ID resume; status remains read only',async t=>{
 const f=await fixture(t,{lose:'after-handle'});await f.api.invoke('upload',args);const next=await f.create();
 assert.equal((await next.invoke('status',args)).state,'staging');assert.equal(f.counts.resume,0);assert.equal((await next.invoke('resume-upload',args)).requestId,requestId);
 await next.invoke('resume-upload',args);assert.equal(f.counts.resume,1);assert.equal(f.counts.upload,1);
});
test('partial journal, changed manifest and expiry fail closed without an initial effect',async t=>{
 const partial=await fixture(t);await writeFile(join(partial.journal,capId+'.claim.json'),'',{mode:0o600});assert.equal((await partial.api.invoke('upload',args)).state,'unknown');assert.equal(partial.counts.open,0);
 const changed=await fixture(t);await changed.api.invoke('upload',args);const altered=await changed.create({...changed.manifest,capabilities:[{...changed.cap,publicName:'다른 이름'}]});assert.equal((await altered.invoke('upload',args)).state,'unknown');assert.equal(changed.counts.upload,1);
 const expired=await fixture(t),expiredApi=await expired.create({...expired.manifest,capabilities:[{...expired.cap,expiresAt:Date.now()-1}]});assert.equal((await expiredApi.invoke('upload',args)).state,'unknown');assert.equal(expired.counts.open,0);await assert.rejects(access(join(expired.journal,capId+'.claim.json')),{code:'ENOENT'});
});
test('pending and prepared downloads differ from verified binary and empty saved receipts',async t=>{
 for(const bytes of [Buffer.from([0,255,19]),Buffer.alloc(0)]){
 const f=await fixture(t,{direction:'download',bytes});assert.equal((await f.api.invoke('request-download',args)).state,'pending');assert.equal((await f.api.invoke('save',args)).state,'pending');assert.equal(f.counts.save,0);await assert.rejects(access(join(f.journal,capId+'.save-claim.json')),{code:'ENOENT'});
 f.job.state='completed';assert.equal((await f.api.invoke('status',args)).state,'prepared');const saved=await f.api.invoke('save',args);assert.equal(saved.state,'saved');assert.deepEqual(await readFile(f.destination),bytes);
 const again=await f.create();assert.equal((await again.invoke('save',args)).state,'saved');assert.equal(f.counts.save,1);assert.equal(f.counts.download,1);
 }
});
test('destination collision consumes save attempt without overwrite or replay',async t=>{
 const f=await fixture(t,{direction:'download'});await f.api.invoke('request-download',args);f.job.state='completed';await writeFile(f.destination,'existing');
 assert.equal((await f.api.invoke('save',args)).state,'save-unknown');assert.equal(await readFile(f.destination,'utf8'),'existing');await (await f.create()).invoke('save',args);assert.equal(f.counts.save,1);
});
test('publication before journal receipt failure is unknown and never inferred as saved',async t=>{
 const f=await fixture(t,{direction:'download',afterSave:async({journal})=>mkdir(join(journal,capId+'.saved.json'),{mode:0o700})});
 await f.api.invoke('request-download',args);f.job.state='completed';assert.equal((await f.api.invoke('save',args)).state,'save-unknown');assert.deepEqual(await readFile(f.destination),f.bytes);
 assert.equal((await (await f.create()).invoke('save',args)).state,'save-unknown');assert.equal(f.counts.save,1);
});

test('missing, stale or disabled advertised target revision refuses initial mutation',async t=>{
 for(const change of [{revision:undefined},{revision:'0'.repeat(64)},{enabled:false}]){
 const f=await fixture(t);Object.assign(f.targets.targets[0],change);const result=await f.api.invoke('upload',args);
 assert.equal(result.error,'CAPABILITY_TARGET_UNAVAILABLE');assert.equal(f.counts.upload,0);
 }
});
