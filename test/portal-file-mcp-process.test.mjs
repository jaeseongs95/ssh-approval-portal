import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { createApplication } from '../app.mjs';
import { CHUNK_BYTES } from '../src/contracts/ports.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..'),capabilityId='a'.repeat(48),args={capabilityId};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'opaque-mcp-native-')),journal=join(root,'journal'),manifestPath=join(root,'manifest.json'),log=join(root,'effects.jsonl'),source=join(root,'PRIVATE-source.bin');
 await mkdir(journal,{mode:0o700});await writeFile(source,'fixture');
 const cap={id:capabilityId,publicName:'고정 입력.bin',target:'default',targetRevision:'d'.repeat(64),remotePath:'/tmp/PRIVATE-native.bin',size:7,sha256:createHash('sha256').update('fixture').digest('hex'),expiresAt:Date.now()+600000,elevate:false,direction:'upload',source,overwrite:false};
 await writeFile(manifestPath,JSON.stringify({version:1,origin:'https://fixture.invalid',capabilities:[cap]}),{mode:0o600});
 const clients=new Set();t.after(async()=>{for(const c of clients)await c.close();assert.ok(root.startsWith(join(tmpdir(),'opaque-mcp-native-')));await rm(root,{recursive:true,force:true});});
 async function connect(mode='normal'){
  const transport=new StdioClientTransport({command:process.execPath,args:[join(repository,'test/portal-file-mcp.fixture.mjs'),manifestPath,journal,log,mode],cwd:root,stderr:'pipe'});
  let stderr='';transport.stderr.on('data',b=>{stderr+=b;});
  const c=new Client({name:'owned-native-test',version:'1.0.0'});await c.connect(transport);clients.add(c);
  return{c,async close(){await c.close();clients.delete(c);assert.equal(stderr.includes('PRIVATE-'),false);},async call(name,arguments_={}){return c.callTool({name,arguments:arguments_},undefined,{timeout:10000});}};
 }
 async function effects(){return readFile(log,'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(JSON.parse),e=>{if(e.code==='ENOENT')return[];throw e;});}
 return{root,journal,cap,connect,effects};
}
test('native SDK exposes strict opaque schemas and refuses additional authority without effects',{timeout:20000},async t=>{
 const f=await fixture(t),p=await f.connect(),listed=await p.c.listTools();
 assert.equal(listed.tools.length,6);
 const caps=await p.call('file_capabilities');assert.equal(caps.structuredContent.capabilities[0].capabilityId,capabilityId);assert.equal(JSON.stringify(caps).includes('PRIVATE-'),false);
 for(const bad of [{...args,path:f.cap.source},{...args,origin:'https://other.invalid'},{...args,approve:true},{capabilityId:'f'.repeat(48)}]){
  const r=await p.call('file_upload',bad).catch(()=>({isError:true}));assert.equal((await f.effects()).filter(x=>x.effect==='upload').length,0,'Rejected extra arguments must not start a file mutation');assert.equal(r.isError,true);
 }
 for(const tool of listed.tools){assert.equal(tool.inputSchema.additionalProperties,false);assert.deepEqual(Object.keys(tool.inputSchema.properties),tool.name==='file_capabilities'?[]:['capabilityId']);}
 assert.deepEqual(await f.effects(),[]);assert.deepEqual(await readdir(f.journal),[]);await p.close();
});
test('fresh native processes race one durable initial claim and observe after restart',{timeout:20000},async t=>{
 const f=await fixture(t),a=await f.connect(),b=await f.connect();
 const values=await Promise.all([a.call('file_upload',args),b.call('file_upload',args)]);assert.ok(values.some(x=>x.structuredContent?.requestId==='c'.repeat(48)));
 assert.equal((await f.effects()).filter(x=>x.effect==='upload').length,1);
 await a.close();await b.close();const c=await f.connect();assert.equal((await c.call('file_upload',args)).structuredContent.requestId,'c'.repeat(48));assert.equal((await f.effects()).filter(x=>x.effect==='upload').length,1);await c.close();
});
test('actual process crash after effect but before handle never creates replacement upload',{timeout:20000},async t=>{
 const f=await fixture(t),a=await f.connect('crash');
 await assert.rejects(a.call('file_upload',args));await a.close();
 const b=await f.connect();assert.equal((await b.call('file_upload',args)).structuredContent.state,'unknown');assert.equal((await b.call('file_upload_resume',args)).structuredContent.state,'unknown');
 assert.equal((await f.effects()).filter(x=>x.effect==='upload').length,1);await b.close();
});

test('production stdio entry uses verified TLS and actual owner app for fixed binary and empty PC roundtrips',{timeout:60000},async t=>{
 const run=promisify(execFile),openssl=process.env.OWNER_CLI_TEST_OPENSSL??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
 await run(openssl,['version'],{timeout:10000,windowsHide:true}); // Required here; missing prerequisite is not a passing skip.
 const root=await mkdtemp(join(tmpdir(),'opaque-mcp-http-')),journal=join(root,'journal'),cert=join(root,'cert.pem'),key=join(root,'key.pem'),manifestPath=join(root,'manifest.json');
 await mkdir(journal,{mode:0o700});
 let app,edge,client;const remote=new Map(),staged=new Map(),effects=[],edgeCalls=[],transportRef={};
 t.after(async()=>{
  await client?.close();if(edge){edge.closeAllConnections();await new Promise(resolve=>edge.close(resolve));}await app?.close();
  assert.ok(root.startsWith(join(tmpdir(),'opaque-mcp-http-')));await rm(root,{recursive:true,force:true});
 });
 await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=opaque-mcp-http','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{timeout:15000,windowsHide:true});
 edge=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
  const headers={...req.headers,'cf-access-jwt-assertion':req.headers['cf-access-token']??''};delete headers['cf-access-token'];
  edgeCalls.push({method:req.method,path:new URL(req.url,'https://fixture.invalid').pathname});
  const upstream=request({host:'127.0.0.1',port:app.adminHttp.address().port,path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
 });edge.on('tlsClientError',()=>{});await new Promise(resolve=>edge.listen(0,'127.0.0.1',resolve));
 const origin='https://127.0.0.1:'+edge.address().port,issuer='https://fixture.cloudflareaccess.com',aud='a'.repeat(64),{privateKey,publicKey}=await generateKeyPair('RS256');
 app=await createApplication({registry:{getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}},classify:()=>({class:'privileged'}),executeCommand:async()=>{assert.fail('No SSH command execution');},audit:()=>{},transferRoot:join(root,'store'),uiHtml:'<html></html>',
 env:{BRIDGE_MCP_TOKEN:'fixture-mcp',BRIDGE_ADMIN_TOKEN:'fixture-maintenance',BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_ADMIN_ORIGIN:origin,BRIDGE_ADMIN_AUTH_MODE:'access',BRIDGE_ACCESS_TEAM_DOMAIN:issuer,BRIDGE_ACCESS_AUD:aud,BRIDGE_ACCESS_OWNER_EMAILS:'owner@example.test'},
 accessKeySet:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'fixture'}]})});
 app.transfers.transport={connect:async()=>({
  upload:async(source,path)=>{const parts=[];for await(const b of source)parts.push(Buffer.from(b));staged.set(path.split('/').at(-1).slice(0,-5),Buffer.concat(parts));},
  download:async(path,destination)=>destination.end(staged.get(path.split('/').at(-1).slice(0,-5))),
  call:async(_command,op)=>{
   if(op.action==='publish'){assert.equal(remote.has(op.remotePath)&&!op.overwrite,false);const b=staged.get(op.id);assert.equal(b.length,op.size);assert.equal(createHash('sha256').update(b).digest('hex'),op.sha256);remote.set(op.remotePath,b);effects.push('upload');return{exitCode:0,stdout:JSON.stringify({size:b.length,sha256:op.sha256})};}
   if(op.action==='snapshot'){const b=remote.get(op.remotePath);assert.ok(b);staged.set(op.id,Buffer.from(b));effects.push('download');return{exitCode:0,stdout:JSON.stringify({size:b.length,sha256:createHash('sha256').update(b).digest('hex')})};}
   assert.equal(op.action,'cleanup');staged.delete(op.id);return{exitCode:0,stdout:'{}'};
  }
 })};
 await new Promise(resolve=>app.adminHttp.listen(0,'127.0.0.1',resolve));
 const token=await new SignJWT({email:'owner@example.test',type:'app'}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(issuer).setAudience(aud).setSubject('owner@example.test').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 let cookie;const owner=async(path,body)=>{const r=await fetch('http://127.0.0.1:'+app.adminHttp.address().port+path,{method:body===undefined?'GET':'POST',headers:{'cf-access-jwt-assertion':token,Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200);return r;};
 const login=await owner('/api/session/start',{});cookie=login.headers.get('set-cookie').split(';')[0];await login.body.cancel();
 const targets=await(await owner('/api/targets')).json(),target=targets.targets[0];
 const capabilities=[],pairs=[];
 for(const [i,bytes]of [Buffer.alloc(CHUNK_BYTES+9),Buffer.alloc(0)].entries()){
  for(let n=0;n<bytes.length;n++)bytes[n]=n%251;
  const source=join(root,'PRIVATE-source-'+i+'.bin'),destination=join(root,'PRIVATE-saved-'+i+'.bin'),remotePath='/tmp/opaque-native-'+i+'.bin',size=bytes.length,sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(source,bytes);const base={publicName:'고정 파일 '+i,target:target.id,targetRevision:target.revision,remotePath,size,sha256,expiresAt:Date.now()+600000,elevate:false};
  const uploadId=String(i*2+1).repeat(48),downloadId=String(i*2+2).repeat(48);
  capabilities.push({...base,id:uploadId,direction:'upload',source,overwrite:false},{...base,id:downloadId,direction:'download',destination});pairs.push({uploadId,downloadId,bytes,destination,remotePath});
 }
 await writeFile(manifestPath,JSON.stringify({version:1,origin,capabilities}),{mode:0o600});
 // Synthetic helper is an owned file, executed by pinned Node as "access token".
 // It tests the production helper argv/private pipe; no real auth cache is read.
 await writeFile(join(root,'access'),'if(process.argv[2]!=="token"||process.argv[3]!=='+JSON.stringify('--app='+origin)+')process.exit(7);process.stdout.write('+JSON.stringify(token+'\n')+');\n',{mode:0o600});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(repository,'scripts/portal-file-mcp.mjs'),'--manifest',manifestPath,'--journal',journal,'--cloudflared',process.execPath],cwd:root,env:{NODE_EXTRA_CA_CERTS:cert},stderr:'pipe'});
 transportRef.value=transport;let stderr='';transport.stderr.on('data',b=>{stderr+=b;});
 client=new Client({name:'owned-production-stdio-test',version:'1.0.0'});await client.connect(transport);
 const call=async(name,id)=>{const r=await client.callTool({name,arguments:{capabilityId:id}},undefined,{timeout:15000});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(JSON.stringify(r).includes(token),false);assert.equal(JSON.stringify(r).includes('PRIVATE-'),false);return r.structuredContent;};
 for(const p of pairs){
  const upload=await call('file_upload',p.uploadId);assert.equal(upload.state,'pending');assert.equal(remote.has(p.remotePath),false);
  const approvedUpload=await(await owner('/api/'+upload.requestId+'/approve',{})).json();assert.equal(approvedUpload.state,'completed');assert.deepEqual(remote.get(p.remotePath),p.bytes);
  const download=await call('file_download_request',p.downloadId);assert.equal(download.state,'pending');
  const pending=await call('file_save',p.downloadId);assert.equal(pending.state,'pending');await assert.rejects(access(p.destination),{code:'ENOENT'});
  assert.equal((await(await owner('/api/'+download.requestId+'/approve',{})).json()).state,'completed');
  assert.equal((await call('file_status',p.downloadId)).state,'prepared');assert.equal((await call('file_save',p.downloadId)).state,'saved');assert.deepEqual(await readFile(p.destination),p.bytes);
  assert.equal((await call('file_save',p.downloadId)).state,'saved');
 }
 assert.deepEqual(effects,['upload','download','upload','download']);assert.equal(edgeCalls.filter(x=>x.path.endsWith('/approve')||x.path.endsWith('/deny')).length,0);
 assert.equal(edgeCalls.filter(x=>x.path==='/api/files/uploads'&&x.method==='POST').length,2);assert.equal(edgeCalls.filter(x=>x.path==='/api/files/downloads'&&x.method==='POST').length,2);assert.equal(stderr.includes(token),false);
 await client.close();client=undefined;assert.equal(stderr.includes('PRIVATE-'),false);
});
