import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPortalClient } from '../src/adapters/cli/portal-client.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'), jobId='a'.repeat(48), transferId='b'.repeat(48), artifactId='c'.repeat(48), revision='d'.repeat(64);
async function fixture(t,{bytes=Buffer.from([0,255,17]),onJob}={}){
 const root=await mkdtemp(join(tmpdir(),'bound-file-client-'));t.after(async()=>{assert.ok(root.startsWith(join(tmpdir(),'bound-file-client-')));await rm(root,{recursive:true,force:true});});
 const source=join(root,'source.bin'),destination=join(root,'saved.bin');await writeFile(source,bytes);
 const expected={size:bytes.length,sha256:hash(bytes),target:'default',targetRevision:revision,remotePath:'/tmp/bound.bin',elevate:false};
 const uploadIntent={target:'default',expectedTargetRevision:revision,remotePath:expected.remotePath,elevate:false,overwrite:false};
 const downloadJob={id:jobId,kind:'download',state:'completed',operation:{kind:'download',remotePath:expected.remotePath,elevate:false,fileTargetId:'default',fileTargetRevision:revision},result:{structuredContent:{artifactId,fileName:'remote.bin',size:bytes.length,sha256:hash(bytes)}}};
 const record={transfer:{id:transferId,state:'staging',fileTargetBound:true,targetId:'default',targetRevision:revision,remotePath:expected.remotePath,elevate:false,overwrite:false,size:bytes.length,sha256:hash(bytes),received:0,sequence:0,expiresAt:Date.now()+600000}};
 const listed={defaultTarget:'default',targets:[{id:'default',enabled:true,revision}]},calls=[];
 const json=(x,headers={})=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json',...headers}});
 const client=createPortalClient({origin:'https://fixture.invalid',accessToken:'fixture.private.token',fetch:async(url,options)=>{
 const path=new URL(url).pathname;calls.push({path,method:options.method});
 if(path==='/api/session')return json({mode:'access'});
 if(path==='/api/session/start')return json({connected:true},{'set-cookie':'__Host-ssh_admin_session='+'e'.repeat(64)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600'});
 if(path==='/api/session/logout')return json({connected:false});
 if(path==='/api/targets')return json(listed);
 if(path==='/api/'+jobId){onJob?.();return json(downloadJob);}
 if(path==='/api/'+jobId+'/download')return json({downloadUrl:'https://fixture.invalid/downloads/'+artifactId+'/'+'f'.repeat(32)+'?ticket=synthetic'});
 if(path.startsWith('/downloads/'))return new Response(bytes,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}});
 if(path==='/api/files/uploads/'+transferId)return json(record);
 if(path.endsWith('/chunks')){const body=JSON.parse(options.body);record.transfer.sequence++;record.transfer.received+=Buffer.from(body.data,'base64').length;return json({sequence:record.transfer.sequence,received:record.transfer.received});}
 if(path.endsWith('/finish'))return json({id:jobId,kind:'upload',state:'pending',operation:{kind:'upload',artifactId:transferId,size:bytes.length,sha256:hash(bytes),remotePath:expected.remotePath,elevate:false,overwrite:false,fileTargetId:'default',fileTargetRevision:revision}});
 assert.fail('Unexpected fixture route');
 }});
 await client.connect();t.after(()=>client.close());return {client,root,source,destination,expected,uploadIntent,downloadJob,record,listed,calls};
}
const fileEffects=f=>f.calls.filter(x=>x.method==='POST'&&x.path!=='/api/session/start'&&x.path!=='/api/session/logout');
test('guarded save checks fixed bytes and operation before ticket or publication',async t=>{
 for(const changes of [{size:0},{sha256:'0'.repeat(64)},{target:'other'},{targetRevision:'0'.repeat(64)},{remotePath:'/tmp/other'},{elevate:true}]){
  const f=await fixture(t);await assert.rejects(f.client.save(jobId,f.destination,{...f.expected,...changes}),{code:'DOWNLOAD_EXPECTATION_MISMATCH'});
  assert.equal(fileEffects(f).length,0);await assert.rejects(access(f.destination),{code:'ENOENT'});
 }
});
test('guarded save accepts exact binary and empty contents and preserves old calls',async t=>{
 for(const bytes of [Buffer.from([0,255,17]),Buffer.alloc(0)])for(const guarded of [true,false]){
 const f=await fixture(t,{bytes});const r=await f.client.save(jobId,f.destination,guarded?f.expected:undefined);assert.equal(r.state,'saved');assert.equal(r.sha256,hash(bytes));assert.deepEqual(await readFile(f.destination),bytes);
 }
});
test('guarded save rejects malformed expectations before HTTP',async t=>{
 const f=await fixture(t),before=f.calls.length;
 for(const value of [null,{}, {...f.expected,extra:true},{...f.expected,targetRevision:'invalid'},{...f.expected,size:-1},{...f.expected,remotePath:'/tmp/../x'}])await assert.rejects(f.client.save(jobId,f.destination,value),{code:'INVALID_DOWNLOAD_EXPECTATION'});
 assert.equal(f.calls.length,before);
});
test('guarded save binds a copied expectation to its own metadata read',async t=>{
 let declared;const f=await fixture(t,{onJob:()=>Object.assign(declared,f.expected)});declared={...f.expected,sha256:'0'.repeat(64)};
 await assert.rejects(f.client.save(jobId,f.destination,declared),{code:'DOWNLOAD_EXPECTATION_MISMATCH'});assert.equal(fileEffects(f).length,0);
});
test('bound resume accepts original revision and bytes on the same transfer ID',async t=>{
 const f=await fixture(t);const r=await f.client.resumeUpload(transferId,f.source,f.uploadIntent,{size:f.expected.size,sha256:f.expected.sha256});
 assert.equal(r.operation.artifactId,transferId);assert.equal(r.operation.fileTargetRevision,revision);assert.equal(f.calls.some(x=>x.path==='/api/files/uploads'),false);assert.equal(fileEffects(f).length,2);
});
test('bound resume refuses current epoch or recorded binding mismatch without mutation',async t=>{
 for(const which of ['listed','record','operation']){
 const f=await fixture(t);if(which==='listed')f.listed.targets[0].revision='0'.repeat(64);
 else if(which==='record')f.record.transfer.targetRevision='0'.repeat(64);
 else {f.record.job={id:jobId,kind:'upload',state:'pending',operation:{...f.downloadJob.operation,kind:'upload',artifactId:transferId,size:f.expected.size,sha256:f.expected.sha256,overwrite:false,fileTargetRevision:'0'.repeat(64)}};delete f.record.transfer;}
 await assert.rejects(f.client.resumeUpload(transferId,f.source,f.uploadIntent,{size:f.expected.size,sha256:f.expected.sha256}),{code:'RESUME_INTENT_MISMATCH'});assert.equal(fileEffects(f).length,0);
 }
});
test('resume checks declared source bytes even for legacy calls before chunks',async t=>{
 const f=await fixture(t),intent={remotePath:f.expected.remotePath};
 await assert.rejects(f.client.resumeUpload(transferId,f.source,intent,{size:0,sha256:hash(Buffer.alloc(0))}),{code:'RESUME_SOURCE_MISMATCH'});assert.equal(fileEffects(f).length,0);
});
