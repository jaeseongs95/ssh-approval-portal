import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preparePythonSource} from './python-source.mjs';
import {agentCliProvider,validateAgentRelease,AGENT_CLI_CONTRACT} from '../../domain/agent-cli.mjs';

const source=readFileSync(new URL('../../../scripts/manage-agent-cli.py',import.meta.url),'utf8');
const id=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stable=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const refuse=()=>{throw Error('CLI result unknown; inspect saved status, never retry automatically');};
function receiptDigest(args){
 const intent={action:args[0],expires:Number(args[5]),expected:args[4],integrity:args[3],provider:args[1],version:args[2]};
 const canonical=Object.fromEntries(Object.keys(intent).sort().map(key=>[key,intent[key]]));
 return createHash('sha256').update(JSON.stringify(canonical)+'\n').digest('hex');
}

/** Fixed server-owned helper only. This port prepares bytes and grants no authority. */
export function prepareAgentCliPlan({action,provider,binding,release,expectedInstallationRevision,expiresAt,operationId,expectedIntentDigest}) {
 agentCliProvider(provider);
 if(!['inspect','status','install','update'].includes(action))throw Error('Invalid CLI helper action');
 if(expectedIntentDigest!==undefined&&action!=='status')throw Error('Invalid CLI helper fields');
 let args,intentDigest;
 if(['install','update'].includes(action)){
  const checked=validateAgentRelease(provider,{name:release?.packageName,version:release?.version,dist:{tarball:release?.tarball,integrity:release?.integrity}});
  if(checked.releaseDigest!==release.releaseDigest||release.provider!==provider||!hex(expectedInstallationRevision)||!id(operationId)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('Invalid CLI helper plan');
  args=[action,provider,checked.version,checked.integrity,expectedInstallationRevision,String(expiresAt),operationId];
  intentDigest=receiptDigest(args);
 }else{
  if(release!==undefined||expectedInstallationRevision!==undefined||expiresAt!==undefined||(action==='inspect'?operationId!==undefined:!id(operationId)||!hex(expectedIntentDigest)))throw Error('Invalid CLI helper fields');
  args=[action,provider,'','','','',operationId??''];
  if(action==='status')intentDigest=expectedIntentDigest;
 }
 const plan=preparePythonSource({source,argv:args,cwd:'/',elevate:false,targetId:binding?.targetId,targetRevision:binding?.targetRevision,profile:binding?.profile});
 return Object.freeze({...plan,agentCli:Object.freeze({contract:AGENT_CLI_CONTRACT,action,provider,...(operationId===undefined?{}:{operationId}),...(intentDigest===undefined?{}:{intentDigest})})});
}

/** Recreate from the fixed helper; a caller-prepared generic Python plan is insufficient. */
export function validateAgentCliPlan(plan){
 if(!record(plan?.manifest)||!record(plan.agentCli))throw Error('Invalid CLI delivery plan');
 let args;try{args=JSON.parse(plan.manifest.argvJson);}catch{throw Error('Invalid CLI delivery plan');}
 if(!Array.isArray(args)||args.length!==7||args.some(arg=>typeof arg!=='string'))throw Error('Invalid CLI delivery plan');
 const [action,provider,version,integrity,expected,expires,operationId]=args;
 const entry=agentCliProvider(provider),binding={targetId:plan.manifest.targetId,targetRevision:plan.manifest.targetRevision,profile:plan.manifest.profile};
 let exact;
 if(['install','update'].includes(action)){
  const release=validateAgentRelease(provider,{name:entry.packageName,version,dist:{tarball:'https://registry.npmjs.org/'+entry.packageName+'/-/'+entry.packageName.split('/')[1]+'-'+version+'.tgz',integrity}});
  exact=prepareAgentCliPlan({action,provider,binding,release,expectedInstallationRevision:expected,expiresAt:Number(expires),operationId});
 }else{
  if([version,integrity,expected,expires].some(value=>value!==''))throw Error('Invalid CLI delivery fields');
  exact=prepareAgentCliPlan({action,provider,binding,...(action==='status'?{operationId,expectedIntentDigest:plan.agentCli.intentDigest}:operationId?{operationId}:{})});
 }
 if(plan.stdin!==exact.stdin||plan.command!==exact.command||plan.planDigest!==exact.planDigest||JSON.stringify(plan.manifest)!==JSON.stringify(exact.manifest)||JSON.stringify(plan.args)!==JSON.stringify(exact.args)||JSON.stringify(plan.agentCli)!==JSON.stringify(exact.agentCli))throw Error('CLI delivery plan changed');
 return exact;
}

/** Derive only a readonly receipt lookup from public persisted fields, never installation authority. */
export function prepareAgentCliStatus(operation,binding){
 if(operation?.agentCliContract!==AGENT_CLI_CONTRACT||operation.agentCliTargetId!==binding.targetId||operation.agentCliTargetRevision!==binding.targetRevision||operation.agentCliProfile!==binding.profile||operation.sourceElevate!==false||operation.sourceCwd!=='/'||typeof operation.sourceArgvJson!=='string'||Buffer.byteLength(operation.sourceArgvJson)>4096)throw Error('CLI status binding changed');
 let args;try{args=JSON.parse(operation.sourceArgvJson);}catch{throw Error('Invalid CLI saved arguments');}
 if(!Array.isArray(args)||args.length!==7||args.some(value=>typeof value!=='string')||!['install','update'].includes(args[0])||args[0]!==operation.agentCliAction||args[1]!==operation.agentCliProvider||args[6]!==operation.agentCliOperationId||!hex(args[4])||!Number.isSafeInteger(Number(args[5]))||Number(args[5])<=0||String(Number(args[5]))!==args[5])throw Error('Invalid CLI saved arguments');
 const entry=agentCliProvider(args[1]);validateAgentRelease(args[1],{name:entry.packageName,version:args[2],dist:{tarball:'https://registry.npmjs.org/'+entry.packageName+'/-/'+entry.packageName.split('/')[1]+'-'+args[2]+'.tgz',integrity:args[3]}});
 return prepareAgentCliPlan({action:'status',provider:args[1],binding,operationId:args[6],expectedIntentDigest:receiptDigest(args)});
}

/** Strict public projection after SSH. No raw stdout, stderr, error or opaque extra field survives. */
export function projectAgentCliResult(result,plan){
 if(result?.exitCode!==0||result.signal||typeof result.stdout!=='string'||!result.stdout.isWellFormed()||Buffer.byteLength(result.stdout)>16384||result.stderr)refuse();
 let value;try{value=JSON.parse(result.stdout);}catch{refuse();}
 if(!record(value))refuse();
 const {action,provider,operationId,intentDigest}=plan.agentCli;
 let data={contract:AGENT_CLI_CONTRACT,action,provider,login:'not_checked'};
 if(action==='inspect'){
  if(value.provider!==provider||typeof value.installed!=='boolean'||typeof value.managed!=='boolean'||value.login!=='not_checked'||!hex(value.installationRevision)||!(value.version===null||stable(value.version)))refuse();
  if(value.managed){if(!value.installed||!stable(value.version)||typeof value.active!=='string'||!new RegExp('^versions/'+value.version.replaceAll('.','\\.')+'-[a-f0-9]{16}$').test(value.active))refuse();}
  else if(!value.installed){if(value.version!==null||value.active!==null)refuse();}
  else if(typeof value.active!=='string'||!value.active.startsWith('/')||!value.active.endsWith('/'+agentCliProvider(provider).command)||value.active.length>512||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.active))refuse();
  data={...data,installed:value.installed,managed:value.managed,version:value.version,active:value.active,installationRevision:value.installationRevision};
 }else{
  if(value.operationId!==operationId)refuse();
  const states=action==='status'?['not_found','unknown','preparing','installing','completed','reused','failed']:['completed','reused'];
  if(!states.includes(value.state))refuse();
  if(value.state!=='not_found'){
   if(value.provider!==provider||value.intentDigest!==intentDigest||!stable(value.version)||value.login!=='not_checked')refuse();
   if(action!=='status'&&value.version!==JSON.parse(plan.manifest.argvJson)[2])refuse();
  }
  data={...data,state:value.state,operationId,...(value.state==='not_found'?{}:{version:value.version}),...(value.state==='failed'?{error:'INSTALL_FAILED'}:{})};
 }
 return {failed:false,texts:[],data:{agentCli:Object.freeze(data)}};
}
