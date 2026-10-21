// Boot the real bridge/composition with synthetic credentials and SSH ports only.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {once} from 'node:events';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyCommand} from 'ssh-mcp/build/policy/classifier.js';
const root=await mkdtemp(join(tmpdir(),'bridge-cli-runtime-'));
const env={BRIDGE_MCP_TOKEN:'synthetic-mcp',BRIDGE_ADMIN_TOKEN:'synthetic-owner',BRIDGE_UI_TICKET_KEY:'a'.repeat(64),BRIDGE_ADMIN_ORIGIN:'https://owner.test',BRIDGE_JEV_ENABLED:'false',BRIDGE_COMMAND_AUTOMATION:'false',BRIDGE_TRANSFER_ROOT:root};
const calls=[];
const registry={getProfile:name=>({host:'127.0.0.1',port:22,user:'fixture',readOnly:name==='aws-readonly'}),closeAll:async()=>{}};
const runtime={registry,classify:classifyCommand,auditRedact:value=>value,executeCommand:async()=>{calls.push('command');throw Error('Unexpected SSH');},executePythonSource:async()=>{calls.push('source');throw Error('Unexpected SSH');},executeAgentCli:async()=>{calls.push('cli');throw Error('Unexpected SSH');}};
globalThis.__bridgeCliFixture={env,runtime,app:null};
const url=p=>new URL(p,import.meta.url).href;
const appUrl=url('../app.mjs'),settingsUrl=url('../src/adapters/config/settings.mjs');
const replacements=new Map([
 [url('../src/adapters/config/secrets.mjs'),'export async function loadSecrets(){return globalThis.__bridgeCliFixture.env;}'],
 [url('../src/adapters/audit/jsonl.mjs'),'export function createAudit(){return ()=>{};}'],
 [url('../src/adapters/ssh/vendor.mjs'),'export async function createSshRuntime(){return globalThis.__bridgeCliFixture.runtime;}export function createSshTransport(){return {connect(){throw Error("Unexpected SSH transport");}};}'],
 [settingsUrl,`export * from ${JSON.stringify(settingsUrl+'?actual')};import {parseSettings as real} from ${JSON.stringify(settingsUrl+'?actual')};export function parseSettings(env){return {...real(env),mcpPort:0,adminPort:0};}`],
 [appUrl,`import {createApplication as real} from ${JSON.stringify(appUrl+'?actual')};export async function createApplication(options){const app=await real(options);globalThis.__bridgeCliFixture.app=app;return app;}`],
]);
const hooks=registerHooks({load(url,context,nextLoad){const source=replacements.get(url);return source===undefined?nextLoad(url,context):{format:'module',source,shortCircuit:true};}});
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,...args)=>{const u=new URL(typeof input==='string'?input:input.url??input);assert.equal(u.hostname,'127.0.0.1','External network forbidden');return originalFetch(input,...args);};
try{
 await import('../bridge.mjs');
 const {app}=globalThis.__bridgeCliFixture;assert.ok(app,'Real composition created');
 for(const server of [app.mcpHttp,app.adminHttp])if(!server.listening)await once(server,'listening');
 const base='http://127.0.0.1:'+app.adminHttp.address().port;
 const response=await fetch(base+'/api/agent-cli',{headers:{Authorization:'Bearer synthetic-owner'}});
 assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.available,true,'Actual bridge must forward executeAgentCli');
 assert.deepEqual(body.providers.map(p=>p.id),['codex','claude']);
 assert.equal((await fetch(base+'/api/agent-cli')).status,401);
 await access(join(root,'agent-cli.sqlite'));
 assert.equal(await access(join(root,'command-automation.sqlite')).then(()=>true,()=>false),false);
 assert.deepEqual(calls,[],'Startup/capability must not execute SSH');
 console.log(JSON.stringify({status:'PASS',actualBridge:true,realApplication:true,syntheticSsh:true,sshCalls:0,modelCalls:0,available:body.available,automationStillDisabled:true}));
}finally{
 await globalThis.__bridgeCliFixture.app?.close();
 globalThis.fetch=originalFetch;hooks.deregister();
 assert.ok(root.startsWith(join(tmpdir(),'bridge-cli-runtime-')));await rm(root,{recursive:true,force:true});
 delete globalThis.__bridgeCliFixture;
}
