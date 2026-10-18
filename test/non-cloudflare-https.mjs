// Isolated Linux fixture only: locally trusted TLS, real bridge and real SSH.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer,request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {loadSecrets} from '../src/adapters/config/secrets.mjs';
import {parseSettings} from '../src/adapters/config/settings.mjs';

const settings=parseSettings(await loadSecrets({file:'/etc/ssh-mcp-approval-bridge.env'}));
assert.equal(settings.adminOrigin,'https://approve.fixture.test:4443');
const root='/root/non-cloudflare-tls',ca=await readFile(root+'/ca.pem');
const proxy=createServer({key:await readFile(root+'/server.key'),cert:await readFile(root+'/server.pem')},(req,res)=>{
 const hostname=req.headers.host?.split(':')[0];
 if(!['approve.fixture.test','mcp.fixture.test'].includes(hostname)){res.writeHead(404);res.end();return;}
 const headers={...req.headers};
 // Forward even forged identity headers: the origin must enforce its token mode.
 const upstream=httpRequest({hostname:'127.0.0.1',port:hostname==='mcp.fixture.test'?settings.mcpPort:settings.adminPort,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
 req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(4443,'127.0.0.1',resolve));
const lookup=(name,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4);
const secure=(path,{host='approve.fixture.test',method='GET',headers={},body,trust=ca}={})=>new Promise((resolve,reject)=>{
 const request=httpsRequest({hostname:host,port:4443,path,method,lookup,ca:trust,agent:false,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,bytes:Buffer.concat(chunks)}));});
 request.setTimeout(5000,()=>request.destroy(Error('Fixture TLS request deadline')));request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
});
const owner={Authorization:'Bearer '+settings.adminToken};
const api=async(path,body,headers={})=>{const response=await secure(path,{method:body===undefined?'GET':'POST',headers:{...owner,...(body===undefined?{}:{Origin:settings.adminOrigin}),...headers},body});assert.equal(response.status,200,'Owner API '+path);return JSON.parse(response.bytes);};
let serial=0;
const call=async(name,args={})=>{const response=await secure('/mcp',{host:'mcp.fixture.test',method:'POST',headers:{Authorization:'Bearer '+settings.mcpToken,Accept:'application/json, text/event-stream'},body:{jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name,arguments:args}}});assert.equal(response.status,200,'TLS MCP '+name);const result=JSON.parse(response.bytes).result;assert.ok(result&&!result.isError,'MCP '+name);return result;};
const approve=async job=>{
 assert.equal(job.state,'pending');await api('/api/'+job.id+'/approve',{});
 for(let attempt=0;attempt<300;attempt++){const result=await api('/api/'+job.id);if(['completed','failed'].includes(result.state)){assert.equal(result.state,'completed');return result;}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.fail('Approved operation deadline');
};
const close=()=>new Promise(resolve=>{proxy.close(resolve);proxy.closeIdleConnections();});
try{
 await assert.rejects(secure('/api/requests',{trust:null}));
 await assert.rejects(secure('/api/requests',{host:'wrong.fixture.test'}));
 for(const headers of [{},{Authorization:'Bearer invalid'},{Authorization:'Bearer '+settings.mcpToken},{'Cf-Access-Jwt-Assertion':'forged','Cf-Access-Authenticated-User-Email':'owner@example.test'}])assert.equal((await secure('/api/requests',{headers})).status,401);
 assert.equal((await secure('/mcp',{host:'mcp.fixture.test',method:'POST',headers:{Accept:'application/json, text/event-stream'},body:{jsonrpc:'2.0',id:0,method:'tools/list'}})).status,401);
 const command=(await call('run-command',{command:'sudo -n id -un'})).structuredContent;
 assert.equal(command.state,'pending');
 assert.equal((await secure('/api/'+command.id+'/approve',{method:'POST',headers:{...owner,Origin:'https://wrong.fixture.test'},body:{}})).status,403);
 assert.equal((await api('/api/'+command.id)).state,'pending');
 const completed=await approve(command);
 const output=await call('read-command-output',{outputId:completed.result.structuredContent.output.id,maxBytes:1024});
 assert.match(output.content[0].text,/root/);
 console.log('HTTPS trusted CA/hostname + missing/wrong/forged credentials + Origin + manual SSH/stored output: PASS');
 const bytes=Buffer.from([0,255,1,128,10,13]),sha256=createHash('sha256').update(bytes).digest('hex');
 const remotePath='/home/mcpops/https-'+randomBytes(12).toString('hex')+'.bin';
 const transfer={direction:'upload',remotePath,elevate:false,overwrite:false};
 const card=await call('show-file-transfer',transfer);
 const started=await call('ui-upload-begin',{transfer,ticket:card._meta.sshApproval.bootstrapTicket,fileName:'binary.bin',size:bytes.length,sha256});
 const id=started.structuredContent.transferId,ticket=started._meta.sshApproval.uploadTicket;
 await call('ui-upload-chunk',{id,ticket,sequence:0,data:bytes.toString('base64')});
 await approve((await call('ui-upload-finish',{id,ticket})).structuredContent);
 const download=(await call('request-download',{remotePath,elevate:false})).structuredContent;
 const ready=await approve(download);assert.equal(ready.result.structuredContent.sha256,sha256);
 const view=await call('show-approval',{id:download.id});
 const link=await call('ui-download-link',{id:download.id,ticket:view._meta.sshApproval.viewTicket});
 const url=new URL(link._meta.sshApproval.downloadUrl);assert.equal(url.origin,settings.adminOrigin);
 assert.equal((await secure(url.pathname)).status,409);
 assert.equal((await secure(url.pathname+url.search,{method:'HEAD'})).status,200);
 const file=await secure(url.pathname+url.search);assert.equal(file.status,200);assert.deepEqual(file.bytes,bytes);
 assert.equal((await secure(url.pathname+url.search)).status,409);
 await approve((await call('run-command',{command:'rm -f -- '+remotePath})).structuredContent);
 console.log('HTTPS owner-approved binary upload/download + exact hash/bytes + missing capability + one-use link: PASS');
 const before=await api('/api/requests');
 await close();
 await assert.rejects(call('run-command',{command:'id -un'}));
 const direct=await fetch(`http://127.0.0.1:${settings.adminPort}/api/requests`,{headers:owner});assert.equal(direct.status,200);
 assert.deepEqual(await direct.json(),before);
 console.log('TLS proxy unavailable: request rejected, no fallback execution or new backend job: PASS');
}finally{if(proxy.listening)await close();}
