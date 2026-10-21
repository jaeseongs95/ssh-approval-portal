import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../src/domain/validation.mjs';
import { commandLineNames } from '../src/domain/command-line.mjs';
import { commandRequest } from '../src/domain/execution-context.mjs';
import { commandDigest, deniedCommand, inspectCommand } from '../src/domain/command-policy.mjs';
import { parseCommandImport } from '../web/src/command-line-import.js';
import { createJevAssessor } from '../src/adapters/safety/jev.mjs';
import { classifyCommand } from 'ssh-mcp/build/policy/classifier.js';
import { createHash, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { SSHConnection } from 'ssh-mcp/build/ssh/connection.js';

const full = (tail='END_MARKER') => 'printf '+ 'x'.repeat(32768-7-tail.length)+tail;
const classify = () => ({class:'safe'});
test('LIMIT-ASCII exact 32KiB accepted and one byte over rejected before classifier', () => {
 for (const command of [full(), 'ls'+' '.repeat(32766)]) {
  assert.equal(Buffer.byteLength(command),32768);
  assert.equal(validateCommand(command,classify).class,'safe');
  assert.equal(commandLineNames(command).complete,true);
  assert.equal(parseCommandImport(command).complete,true);
 }
 let calls=0;
 assert.throws(()=>validateCommand(full()+'x',()=>{calls++;return classify();}));
 assert.equal(calls,0);assert.equal(commandLineNames(full()+'x').complete,false);
 assert.equal(parseCommandImport(full()+'x').reason,'length');
});
test('LIMIT-UTF8 counts Korean/emoji bytes and refuses invalid Unicode or hidden characters', () => {
 for(const atom of ['가','😀']) {
  const width=Buffer.byteLength(atom), prefix='printf ', count=Math.floor((32768-prefix.length)/width);
  const command=prefix+atom.repeat(count)+'x'.repeat(32768-prefix.length-count*width);
  assert.equal(Buffer.byteLength(command),32768);assert.doesNotThrow(()=>validateCommand(command,classify));
  assert.equal(parseCommandImport(command).complete,true);
  assert.throws(()=>validateCommand(command+'x',classify));assert.equal(parseCommandImport(command+'x').reason,'length');
 }
 for(const command of ['printf \ud800','printf \udc00','ls\nrm /tmp/synthetic','ls\0id','ls\u202eid']) assert.throws(()=>validateCommand(command,classify));
 assert.equal(commandLineNames('printf \ud800').complete,false);
});
test('LIMIT-ENVELOPE keeps exact inner bytes and contexts with independent wire and command caps',()=>{
 const command=full(), context='purpose '.repeat(1024), displayContext='설명 '.repeat(2000);
 const wire='ssh-request-v1:'+JSON.stringify({command,context,displayContext});
 assert.ok(Buffer.byteLength(wire)>32768);
 const result=commandRequest(wire);assert.equal(result.command,command);assert.equal(result.context,context);assert.equal(result.displayContext,displayContext);
 assert.throws(()=>commandRequest('ssh-request-v1:'+JSON.stringify({command:command+'x',context})));
 assert.throws(()=>commandRequest(wire,'conflicting context'));
 assert.throws(()=>commandRequest('ssh-request-v1:'+' '.repeat(524288)+JSON.stringify({command:'id',context:'purpose'})));
});
test('LIMIT-TAIL full parser, denied-name guard and digest observe final executable',()=>{
 const command='ls '+ ' '.repeat(32000)+'; rm /tmp/synthetic-only';
 const names=commandLineNames(command);assert.equal(names.complete,true);assert.deepEqual(names.names,['ls','rm']);
 assert.equal(deniedCommand(command,{deniedCommands:['rm']}),true);
 assert.notEqual(commandDigest(command,'r','p'),commandDigest(command.replace(/rm /,'id '),'r','p'));
 assert.ok(inspectCommand(command,classifyCommand));
});
test('LIMIT-RECURSION repeated sudo beyond bounded grammar is incomplete',()=>{
 assert.equal(commandLineNames('sudo '.repeat(17)+'id').complete,false);
 assert.equal(commandLineNames('sudo '.repeat(10000)+'id').complete,false);
 assert.equal(commandLineNames('sudo sudo id').complete,true);
});
test('LIMIT-JEV exact full command and tail delivered once without experimental header',async()=>{
 let seen,calls=0;
 const assessor=createJevAssessor({apiKey:'synthetic-only',fetchImpl:async(_url,options)=>{
  calls++;seen=options;return new Response(JSON.stringify({model:'jev-1.14.0',answers:{risk:{type:'choice',choice:'uncertain',confidence:1,probabilities:{low_risk:0,high_risk:0,uncertain:1}}},usage:{input_tokens:1,output_tokens:1}}),{headers:{'content-type':'application/json'}});
 }});
 for(const command of [full('TAIL_DENIED'), 'printf '+ '가'.repeat(10000)+'END']) {
  const input={command,target:'fixture',environment:'synthetic fixture',context:'Inspect exact synthetic command; never execute'};
  assert.equal((await assessor.assess(input)).status,'assessed');
  assert.equal(JSON.parse(seen.body).state.command,command);assert.ok(Buffer.byteLength(seen.body)<524288);
  assert.equal(Object.keys(seen.headers).some(k=>/danger|long.context/i.test(k)),false);
 }
 assert.equal((await assessor.assess({command:full()+'x',target:'t',environment:'e',context:'c'})).reason,'invalid_input');assert.equal(calls,2);
});
test('LIMIT-JEV provider rejects long input without retry or approval',async()=>{
 let calls=0;const assessor=createJevAssessor({apiKey:'synthetic-only',fetchImpl:async()=>{calls++;return new Response('',{status:413});}});
 assert.deepEqual(await assessor.assess({command:full(),target:'t',environment:'e',context:'c'}),{status:'unavailable',reason:'http_error'});assert.equal(calls,1);
});
test('LIMIT-SSH real pinned loopback channel receives complete 32KiB commands without shell execution',{timeout:20000},async t=>{
 const key=()=>generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
 const hostKey=key(), clients=new Set(),received=[];let connection;
 const server=new ssh2.Server({hostKeys:[hostKey]},client=>{
  clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client));
  client.on('authentication',r=>r.accept());client.on('ready',()=>client.on('session',accept=>{
   const session=accept();session.on('env',accept=>accept?.());session.on('exec',(accept,_reject,info)=>{
    received.push(info.command);const stream=accept();stream.exit(0);stream.end('synthetic transport receipt');
   });
  }));
 });
 t.after(async()=>{await connection?.close();for(const c of clients)c.end();await new Promise(r=>server.close(r));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const trustedHostKey='SHA256:'+createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/,'');
 connection=new SSHConnection({name:'fixture',host:'127.0.0.1',port:server.address().port,user:'synthetic',auth:'key',trustedHostKey,readOnly:false,tty:false,announceAgent:false,timeout:8000,maxOutputBytes:32768},{privateKey:key()},new Map(),'strict');
 for(const command of [full(), 'printf '+ '가'.repeat(10920)+'1']) {
  assert.equal(Buffer.byteLength(command),32768);validateCommand(command,classifyCommand);
  await connection.ensureConnected();assert.equal((await connection.exec(command)).exitCode,0);assert.equal(received.at(-1),command);
 }
 assert.equal(received.length,2);
});
