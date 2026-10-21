import {get} from 'node:https';
import {agentCliProvider,validateAgentRelease} from '../../domain/agent-cli.mjs';

const MAX_METADATA=256*1024,DEADLINE_MS=10000,LIFETIME_MS=300000;
const unavailable=()=>Error('CLI release unavailable');

// Fixed public registry only: no incoming URL/headers, ambient credential or redirect.
function readMetadata(url,request) {
 return new Promise((resolve,reject)=>{
  let connection,timer,settled=false;
  const finish=(error,value)=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   if(error){connection?.destroy();reject(unavailable());}else resolve(value);
  };
  timer=setTimeout(()=>finish(unavailable()),DEADLINE_MS);timer.unref?.();
  try{
   connection=request(url,{agent:false,rejectUnauthorized:true,maxHeaderSize:16384,headers:{accept:'application/json','accept-encoding':'identity'}},response=>{
    let bytes=0,ended=false;const chunks=[];
    response.on('error',()=>finish(unavailable()));
    response.on('aborted',()=>finish(unavailable()));
    response.on('close',()=>{if(!ended)finish(unavailable());});
    if(response.statusCode!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type']??'')||(response.headers['content-encoding']??'identity')!=='identity'){
     response.destroy();finish(unavailable());return;
    }
    response.on('data',chunk=>{
     bytes+=chunk.length;
     if(bytes>MAX_METADATA){response.destroy();finish(unavailable());return;}
     chunks.push(chunk);
    });
    response.on('end',()=>{
     ended=true;
     if(settled)return;
     try{finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
     catch{finish(unavailable());}
    });
   });
   connection.on('error',()=>finish(unavailable()));
  }catch{finish(unavailable());}
 });
}

/** Bounded two-provider catalog; a release plan is data, never execution authority. */
export function createAgentReleaseCatalog({request=get,now=Date.now}={}) {
 const cache=new Map(),pending=new Map();
 return {
  async get(provider){
   const entry=agentCliProvider(provider),started=now();
   if(!Number.isSafeInteger(started)||started<0||started>Number.MAX_SAFE_INTEGER-LIFETIME_MS)throw unavailable();
   const cached=cache.get(provider);
   if(cached&&started<cached.expiresAt)return cached;
   if(pending.has(provider))return pending.get(provider);
   const url='https://registry.npmjs.org/'+entry.packageName.replace('/','%2F')+'/latest';
   const task=readMetadata(url,request).then(metadata=>{
    const release=validateAgentRelease(provider,metadata),finished=now(),expiresAt=started+LIFETIME_MS;
    if(!Number.isSafeInteger(finished)||finished<started||finished>=expiresAt)throw unavailable();
    const plan=Object.freeze({release,fetchedAt:started,expiresAt});cache.set(provider,plan);return plan;
   }).catch(()=>{throw unavailable();}).finally(()=>pending.delete(provider));
   pending.set(provider,task);return task;
  },
 };
}
