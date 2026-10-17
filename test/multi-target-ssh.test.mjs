import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import ssh2 from 'ssh2';
import {createSshRuntime} from '../src/adapters/ssh/vendor.mjs';
import {createApplication} from '../app.mjs';

const key=()=>generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
const pin=privateKey=>'SHA256:'+createHash('sha256').update(ssh2.utils.parseKey(privateKey).getPublicSSH()).digest('base64').replace(/=+$/,'');
function protectFixture(path) {
 if(process.platform!=='win32')return;
 const sid=execFileSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-[0-9-]+/)?.[0];
 if(!sid)throw Error('Cannot determine the synthetic fixture owner');
 const logonSids=[...execFileSync('whoami',['/groups','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).matchAll(/S-1-5-5-\d+-\d+/g)].map(match=>match[0]);
 execFileSync('icacls',[path,'/inheritance:r','/grant:r',`*${sid}:F`,'*S-1-5-18:F','*S-1-5-32-544:F',...logonSids.flatMap(sid=>['/remove:g','*'+sid])],{stdio:'pipe',windowsHide:true});
}
async function server(id,privateKey) {
 const calls=[],clients=new Set();
 const server=new ssh2.Server({hostKeys:[privateKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
  client.on('authentication',context=>context.accept());
  client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('exec',(accept,_reject,info)=>{
    calls.push(info.command);const stream=accept();stream.on('error',()=>{});stream.write(id+'\n');stream.exit(0);stream.end();
   });
  }));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {id,calls,port:server.address().port,hostKey:pin(privateKey),async close(){for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}};
}

test('two independent pinned loopback SSH servers receive only their selected read/write profiles', {timeout:20000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'ssh-two-targets-')),privateKey=key();let alpha,beta,app,runtime;
 try {
  protectFixture(root);
  alpha=await server('alpha',privateKey);beta=await server('beta',key());
  const keyPath=join(root,'synthetic-client.pem');await writeFile(keyPath,privateKey,{mode:0o600});
  const configPath=join(root,'synthetic-config.toml');
  const profiles=[alpha,beta].flatMap(target=>['read','write'].map(mode=>`[[profiles]]\nname = "${target.id}-${mode}"\nhost = "127.0.0.1"\nport = ${target.port}\nuser = "synthetic"\nauth = "key"\nkeyRef = ${JSON.stringify(keyPath)}\ntrustedHostKey = "${target.hostKey}"\nreadOnly = ${mode==='read'}\ngroup = "prod"\nrole = "${mode==='read'?'viewer':'operator'}"\nannounceAgent = false\n`)).join('\n');
  await writeFile(configPath,'[defaults]\ndefaultProfile = "alpha-write"\ncommandTimeoutMs = 3000\n\n'+profiles,{mode:0o600});
  protectFixture(configPath);protectFixture(keyPath);
  const env={BRIDGE_MCP_TOKEN:'loopback-mcp',BRIDGE_ADMIN_TOKEN:'loopback-admin',BRIDGE_ADMIN_ORIGIN:'https://admin.example.test',BRIDGE_UI_TICKET_KEY:'b'.repeat(64),BRIDGE_CONFIG_PATH:configPath,BRIDGE_DEFAULT_TARGET:'alpha',BRIDGE_TARGETS:JSON.stringify([alpha,beta].map(target=>({id:target.id,displayName:target.id,readProfile:target.id+'-read',writeProfile:target.id+'-write',credentialRevision:'synthetic-v1'})))};
  runtime=await createSshRuntime(env);
  app=await createApplication({...runtime,audit:()=>{},transferRoot:join(root,'transfers'),env,uiHtml:'<html>synthetic</html>'});
  assert.equal((await app.targets.commands.read('id -un','beta')).output.state,'ready');
  assert.equal(alpha.calls.length,0);assert.equal(beta.calls.length,1);
  const a=(await app.targets.commands.run('sudo id -u','alpha')).job,b=(await app.targets.commands.run('sudo id -u','beta')).job;
  assert.equal(alpha.calls.length,0);assert.equal(beta.calls.length,1);
  await Promise.all([app.queue.approve(a.id),app.queue.approve(b.id)]);
  assert.equal(alpha.calls.length,1);assert.equal(beta.calls.length,2);
  assert.equal(app.queue.get(a.id).state,'completed');assert.equal(app.queue.get(b.id).state,'completed');
  assert.equal(app.queue.get(a.id).result.output.state,'ready');assert.equal(app.queue.get(b.id).result.output.state,'ready');
  assert.notEqual(app.queue.get(a.id).result.output.id,app.queue.get(b.id).result.output.id);
  // A changed expected key must fail before an SSH exec reaches that server.
  runtime.registry.getProfile('alpha-read').trustedHostKey=beta.hostKey;
  await assert.rejects(app.targets.commands.read('id -un','alpha'));assert.equal(alpha.calls.length,1);
  await assert.rejects(runtime.registry.getOrCreate('alpha-read'));assert.equal(alpha.calls.length,1);
  assert.equal((await app.targets.commands.read('id -un','beta')).output.state,'ready');
 }finally{await app?.close();await runtime?.registry.closeAll();await alpha?.close();await beta?.close();await rm(root,{recursive:true,force:true});}
});
