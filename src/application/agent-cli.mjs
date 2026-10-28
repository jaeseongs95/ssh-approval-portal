import {agentCliIntent,agentCliProvider,validateAgentRelease,AGENT_CLI_CONTRACT} from '../domain/agent-cli.mjs';
import {hash as sha256} from '../domain/validation.mjs';

const fields=['targetId','targetRevision','profile','provider','action','releaseDigest','expectedInstallationRevision','requestKey'];
const loginReasons=['unsafe_path','invalid_installation','timeout','output_limit','unexpected_response','check_failed'];
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=value=>sha256(JSON.stringify(value));
const snapshot=definition=>Object.freeze({targetId:definition.id,targetRevision:definition.revision,profile:definition.writeProfile,enabled:definition.enabled});

/** Internal use case. HTTP authentication and trusted inspection/SSH ports are mandatory at composition. */
export function createAgentCliService({queue,journal,resolveTarget,readInstallation,readLoginState,catalog,preparePlan,executePlan,outputs,checkPolicy,automaticDecision=()=>undefined,now=Date.now,nonce}) {
 if(![resolveTarget,readInstallation,preparePlan,executePlan,checkPolicy,nonce].every(fn=>typeof fn==='function'))throw Error('CLI service ports required');
 const previews=new Map(),executions=new Map();
 let closed=false;
 const open=()=>{if(closed)throw Error('CLI service closed');};
 const definitionFor=targetId=>{
  const definition=resolveTarget(targetId);
  if(!definition||definition.id!==targetId||definition.enabled!==true)throw Error('Registered CLI target required');
  definition.verify();return definition;
 };
 const verifyBinding=binding=>{
  const definition=definitionFor(binding.targetId);
  if(definition.revision!==binding.targetRevision||definition.writeProfile!==binding.profile)throw Error('CLI target changed');
  return definition;
 };
 const reap=()=>{for(const [key,value] of previews)if(now()>=value.expiresAt)previews.delete(key);};
 const isJob=job=>job?.operation?.agentCliContract===AGENT_CLI_CONTRACT;
 const beforeStart=job=>{
  open();
  const entry=executions.get(job?.id);
  if(!isJob(job)||!entry||!['pending','running'].includes(job.state)||JSON.stringify(job.operation)!==entry.operationJson||job.profile!==entry.binding.profile)throw Error('CLI private execution plan unavailable; never reconstruct or replay');
  verifyBinding(entry.binding);
  if(now()>=entry.intent.expiresAt)throw Error('CLI plan expired');
  checkPolicy(entry.plan,entry.binding);
  if(job.decision?.reasonCode==='test_server_bypass'){
   const current=automaticDecision();
   if(current?.reasonCode!=='test_server_bypass'||current.policyRevision!==job.decision.policyRevision)throw Error('CLI automatic policy changed');
  }
  return entry;
 };
 return {
  isJob,beforeStart,
  async loginStatus(body){
   open();
   if(!exact(body,['targetId','provider']))throw Error('Invalid CLI login status fields');
   agentCliProvider(body.provider);
   const binding=snapshot(definitionFor(body.targetId));
   if(queue.maintenance||queue.busy())throw Error('CLI target is busy');
   if(typeof readLoginState!=='function')throw Error('CLI login status unavailable');
   let value;
   try{value=await readLoginState(body.provider,binding);}catch{value={provider:body.provider,state:'unavailable',reason:'check_failed'};}
   open();verifyBinding(binding);if(queue.maintenance)throw Error('CLI maintenance in progress');
   const valid=record(value)&&value.provider===body.provider&&['signed_in','signed_out','not_installed','unavailable'].includes(value.state)&&(!Object.hasOwn(value,'reason')||value.state==='unavailable'&&loginReasons.includes(value.reason));
   const state=valid?value.state:'unavailable',reason=valid?(Object.hasOwn(value,'reason')?value.reason:undefined):'check_failed';
   return Object.freeze({binding,provider:body.provider,state,...(reason===undefined?{}:{reason}),checkedAt:now()});
  },
  async preview(body){
   open();
   if(!exact(body,['targetId','provider']))throw Error('Invalid CLI preview fields');
   agentCliProvider(body.provider);reap();
   if(previews.size>=64)throw Error('CLI preview capacity reached');
   const binding=snapshot(definitionFor(body.targetId));
   if(queue.maintenance||queue.busy())throw Error('CLI target is busy');
   const installed=await readInstallation(body.provider,binding);open();verifyBinding(binding);if(queue.maintenance)throw Error('CLI maintenance in progress');
   if(!record(installed)||installed.provider!==body.provider||typeof installed.managed!=='boolean'||typeof installed.installed!=='boolean'||installed.login!=='not_checked'||!hex(installed.installationRevision)||!(installed.version===null||typeof installed.version==='string'&&/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(installed.version))||(!installed.installed&&(installed.managed||installed.version!==null))||(installed.managed&&!installed.version))throw Error('CLI inspection unavailable');
   const installation=Object.freeze(Object.fromEntries(['provider','managed','installed','version','installationRevision','login'].map(key=>[key,installed[key]])));
   const remote=await catalog.get(body.provider);open();verifyBinding(binding);reap();if(queue.maintenance)throw Error('CLI maintenance in progress');
   if(previews.size>=64||!Number.isSafeInteger(remote.expiresAt)||now()>=remote.expiresAt||remote.expiresAt>now()+300000)throw Error('CLI release plan unavailable');
   const release=validateAgentRelease(body.provider,{name:remote.release?.packageName,version:remote.release?.version,dist:{tarball:remote.release?.tarball,integrity:remote.release?.integrity}});
   if(remote.release?.provider!==body.provider||remote.release?.releaseDigest!==release.releaseDigest)throw Error('CLI release plan changed');
   const planId=nonce();if(!id(planId)||previews.has(planId))throw Error('CLI plan identity unavailable');
   const plan=Object.freeze({planId,binding,installation,release,expiresAt:remote.expiresAt});previews.set(planId,plan);
   return plan;
  },
  submit(body){
   open();
   if(!exact(body,['planId','request'])||!id(body.planId)||!exact(body.request,fields)||fields.some(key=>typeof body.request[key]!=='string'||body.request[key].length>200)||!/^[A-Za-z0-9_.:-]{16,128}$/.test(body.request.requestKey))throw Error('Invalid CLI request');
   const request=body.request;agentCliProvider(request.provider);
   const binding=snapshot(definitionFor(request.targetId));
   if(binding.targetRevision!==request.targetRevision||binding.profile!==request.profile)throw Error('CLI target changed');
   const fingerprint=hash([body.planId,...fields.filter(key=>key!=='requestKey').map(key=>request[key])]),key='agent-cli:'+request.requestKey;
   const found=journal.find(key);
   if(found){
    if(found.digest!==fingerprint||!isJob(found.job))throw Error('CLI request key conflict');
    return queue.get(found.job.id)??found.job;
   }
   reap();const preview=previews.get(body.planId);
   if(!preview||JSON.stringify(preview.binding)!==JSON.stringify(binding)||preview.installation.installationRevision!==request.expectedInstallationRevision)throw Error('CLI preview changed or expired');
   const intent=agentCliIntent(request,{binding,release:preview.release,expiresAt:preview.expiresAt,now:now()});
   if(queue.listAll().some(job=>isJob(job)&&job.operation.agentCliProvider===intent.provider&&job.operation.agentCliTargetId===binding.targetId&&['pending','evaluating','running'].includes(job.state)))throw Error('CLI installation already pending or running');
   const operationId=nonce();if(!id(operationId))throw Error('CLI operation identity unavailable');
   const plan=preparePlan({action:intent.action,provider:intent.provider,binding,release:preview.release,expectedInstallationRevision:intent.expectedInstallationRevision,expiresAt:intent.expiresAt,operationId});
   checkPolicy(plan,binding);
   const operation={kind:'command',command:plan.command,sourceContract:plan.manifest.contract,sourcePlanDigest:plan.planDigest,sourceSha256:plan.manifest.sourceSha256,sourceBytes:plan.manifest.sourceBytes,sourceArgvJson:plan.manifest.argvJson,sourceCwd:plan.manifest.cwd,sourceElevate:false,sourceEnvironmentRevision:plan.manifest.environmentRevision,agentCliContract:AGENT_CLI_CONTRACT,agentCliProvider:intent.provider,agentCliAction:intent.action,agentCliTargetId:binding.targetId,agentCliTargetRevision:binding.targetRevision,agentCliProfile:binding.profile,agentCliOperationId:operationId};
   const job=queue.submitOperation(operation,'privileged',{expiresAt:intent.expiresAt});
   try{journal.insert(job,key,fingerprint);queue.track(job.id,value=>journal.save(value));}
   catch(error){queue.abortEvaluation(job.id);throw error;}
   executions.set(job.id,{binding,intent,plan,operationJson:JSON.stringify(operation)});
   const decision=automaticDecision();
   if(decision){
    queue.setDecision(job.id,decision);
    try{queue.startCommand(job.id);}catch{if(!queue.rejectAutomaticDispatch(job.id))throw Error('CLI automatic dispatch unavailable');}
   }
   return queue.get(job.id);
  },
  async execute(id,beforeDispatch){
   const entry=beforeStart(queue.get(id));
   const reservation=outputs.reserve({executionId:id,targetId:entry.binding.targetId,targetRevision:entry.binding.targetRevision,profile:entry.binding.profile,operationDigest:entry.plan.planDigest});
   try{
    const outcome=await executePlan(entry.plan,()=>{beforeStart(queue.get(id));return entry.binding;},beforeDispatch);
    if(!record(outcome)||typeof outcome.failed!=='boolean'||!Array.isArray(outcome.texts)||outcome.texts.some(text=>typeof text!=='string'))throw Error('CLI execution result unavailable');
    return outputs.finish(reservation,outcome);
   }catch(error){outputs.abandon(reservation);throw error;}
  },
  source(id){const entry=beforeStart(queue.get(id));return {source:entry.plan.stdin,manifest:entry.plan.manifest,planDigest:entry.plan.planDigest};},
  onTerminal(job){executions.delete(job.id);},
  close(){closed=true;previews.clear();executions.clear();},
 };
}
