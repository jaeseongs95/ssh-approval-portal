import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preparePythonHelper} from './python-source.mjs';
import {agentCliProvider,validateAgentRelease,AGENT_CLI_CONTRACT} from '../../domain/agent-cli.mjs';
import {WINDOWS_STDIN_READER} from './windows-stdin.mjs';

const source=readFileSync(new URL('../../../scripts/manage-agent-cli.py',import.meta.url),'utf8');
const loginSource=readFileSync(new URL('../../../scripts/check-agent-cli-login.py',import.meta.url),'utf8');
const windowsSource=readFileSync(new URL('../../../scripts/manage-agent-cli-windows.ps1',import.meta.url),'utf8');
const windowsContract='agent-cli-powershell-v1';
const sha256=value=>createHash('sha256').update(value).digest('hex');
function prepareWindowsHelper({argv,binding}){
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(binding?.targetId??'')||!/^[a-f0-9]{64}$/.test(binding?.targetRevision??'')||!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(binding?.profile??''))throw Error('Invalid CLI target binding');
 const sourceBytes=Buffer.byteLength(windowsSource),sourceSha256=sha256(windowsSource);
 if(sourceBytes>65536)throw Error('Windows CLI helper exceeds transport limit');
 const argumentsLiteral=argv.map(value=>`'${value.replaceAll("'","''")}'`).join(',');
 const receiver=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${WINDOWS_STDIN_READER}$b=[Array]::CreateInstance([byte],${sourceBytes+1});$n=0;while($n -lt $b.Length){$r=[SshApproval.Stdin]::Read($b,$n,$b.Length-$n);if($r -eq 0){break};$n+=$r};if($n -ne ${sourceBytes}){exit 125};$hash=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($hash.ComputeHash($b,0,$n))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()};if($h -cne '${sourceSha256}'){exit 125};$s=[Text.UTF8Encoding]::new($false,$true).GetString($b,0,$n);[IO.Directory]::SetCurrentDirectory('C:\\');& ([scriptblock]::Create($s)) -CliArguments ([string[]]@(${argumentsLiteral}))`;
 const manifest=Object.freeze({contract:windowsContract,interpreter:'powershell.exe',startupFlags:'-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass',receiverSha256:sha256(receiver),sourceSha256,sourceBytes,argvJson:JSON.stringify(argv),cwd:'C:/',elevate:false,targetId:binding.targetId,targetRevision:binding.targetRevision,profile:binding.profile,environmentRevision:sha256('windows-cli-clean-environment-v1'),environmentPolicy:'windows-cli-clean-environment-v1'});
 const args=Object.freeze(['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(receiver,'utf16le').toString('base64')]);
 const command=['powershell.exe',...args].join(' ');
 if(command.length>8000)throw Error('Windows CLI startup command exceeds the encoded shell limit');
 return Object.freeze({manifest,planDigest:sha256(JSON.stringify(manifest)),command,args,stdin:windowsSource});
}
const id=value=>typeof value==='string'&&/^[a-f0-9]{48}$/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stable=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(value);
const loginReasons=['unsafe_path','invalid_installation','timeout','output_limit','unexpected_response','check_failed'];
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
 if(!['inspect','status','install','update','login-status'].includes(action))throw Error('Invalid CLI helper action');
 if(expectedIntentDigest!==undefined&&action!=='status')throw Error('Invalid CLI helper fields');
 let args,intentDigest;
 if(['install','update'].includes(action)){
  const checked=validateAgentRelease(provider,{name:release?.packageName,version:release?.version,dist:{tarball:release?.tarball,integrity:release?.integrity}});
  if(checked.releaseDigest!==release.releaseDigest||release.provider!==provider||!hex(expectedInstallationRevision)||!id(operationId)||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw Error('Invalid CLI helper plan');
  args=[action,provider,checked.version,checked.integrity,expectedInstallationRevision,String(expiresAt),operationId];
  intentDigest=receiptDigest(args);
 }else{
  if(release!==undefined||expectedInstallationRevision!==undefined||expiresAt!==undefined||(['inspect','login-status'].includes(action)?operationId!==undefined:!id(operationId)||!hex(expectedIntentDigest)))throw Error('Invalid CLI helper fields');
  args=action==='login-status'?[action,provider]:[action,provider,'','','','',operationId??''];
  if(action==='status')intentDigest=expectedIntentDigest;
 }
 const windows=binding?.platform==='windows';
 if(binding?.platform!==undefined&&!['linux','windows'].includes(binding.platform))throw Error('Unsupported CLI target platform');
 const plan=windows?prepareWindowsHelper({argv:action==='login-status'?[action,provider,'','','','','']:args,binding}):preparePythonHelper({source:action==='login-status'?loginSource:source,argv:action==='login-status'?[provider]:args,cwd:'/',elevate:false,targetId:binding?.targetId,targetRevision:binding?.targetRevision,profile:binding?.profile});
 return Object.freeze({...plan,agentCli:Object.freeze({contract:AGENT_CLI_CONTRACT,action,provider,...(windows?{platform:'windows'}:{}),...(operationId===undefined?{}:{operationId}),...(intentDigest===undefined?{}:{intentDigest})})});
}

/** Recreate from the fixed helper; a caller-prepared generic Python plan is insufficient. */
export function validateAgentCliPlan(plan){
 if(!record(plan?.manifest)||!record(plan.agentCli))throw Error('Invalid CLI delivery plan');
 let args;try{args=JSON.parse(plan.manifest.argvJson);}catch{throw Error('Invalid CLI delivery plan');}
 const windows=plan.manifest.contract===windowsContract;
 const binding={targetId:plan.manifest.targetId,targetRevision:plan.manifest.targetRevision,profile:plan.manifest.profile,...(windows?{platform:'windows'}:{})};
 if(plan.agentCli.action==='login-status'){
  if(windows){
   if(!Array.isArray(args)||args.length!==7||args[0]!=='login-status'||args.slice(2).some(value=>value!==''))throw Error('Invalid CLI delivery plan');
   const exact=prepareAgentCliPlan({action:'login-status',provider:args[1],binding});
   if(['stdin','command','planDigest','manifest','args','agentCli'].some(key=>JSON.stringify(plan[key])!==JSON.stringify(exact[key])))throw Error('CLI delivery plan changed');
   return exact;
  }
  if(!Array.isArray(args)||args.length!==1)throw Error('Invalid CLI delivery plan');
  const exact=prepareAgentCliPlan({action:'login-status',provider:args[0],binding});
  if(['stdin','command','planDigest','manifest','args','agentCli'].some(key=>JSON.stringify(plan[key])!==JSON.stringify(exact[key])))throw Error('CLI delivery plan changed');
  return exact;
 }
 if(!Array.isArray(args)||args.length!==7||args.some(arg=>typeof arg!=='string'))throw Error('Invalid CLI delivery plan');
 const [action,provider,version,integrity,expected,expires,operationId]=args;
 const entry=agentCliProvider(provider);
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
 if(operation?.agentCliContract!==AGENT_CLI_CONTRACT||operation.agentCliTargetId!==binding.targetId||operation.agentCliTargetRevision!==binding.targetRevision||operation.agentCliProfile!==binding.profile||operation.sourceElevate!==false||operation.sourceCwd!==(binding.platform==='windows'?'C:/':'/')||(binding.platform==='windows'&&operation.sourceContract!==windowsContract)||typeof operation.sourceArgvJson!=='string'||Buffer.byteLength(operation.sourceArgvJson)>4096)throw Error('CLI status binding changed');
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
 if(action==='login-status'){
  if(value.provider!==provider||!['signed_in','signed_out','not_installed','unavailable'].includes(value.state)||Object.hasOwn(value,'reason')&&(value.state!=='unavailable'||!loginReasons.includes(value.reason)))refuse();
  return {failed:false,texts:[],data:{agentCli:Object.freeze({contract:'agent-cli-login-status-v1',provider,state:value.state,...(Object.hasOwn(value,'reason')?{reason:value.reason}:{})})}};
 }
 let data={contract:AGENT_CLI_CONTRACT,action,provider,login:'not_checked'};
 if(action==='inspect'){
  if(value.provider!==provider||typeof value.installed!=='boolean'||typeof value.managed!=='boolean'||value.login!=='not_checked'||!hex(value.installationRevision)||!(value.version===null||stable(value.version)))refuse();
  if(value.managed){if(!value.installed||!stable(value.version)||typeof value.active!=='string'||!new RegExp('^versions/'+value.version.replaceAll('.','\\.')+'-[a-f0-9]{16}$').test(value.active))refuse();}
  else if(!value.installed){if(value.version!==null||value.active!==null)refuse();}
  else if(typeof value.active!=='string'||(plan.agentCli.platform==='windows'?!/^[A-Za-z]:\/(?:[^<>:"|?*\\]+\/)*[^<>:"|?*\\]+\.(?:exe|[cm]?js)$/i.test(value.active):!value.active.startsWith('/')||!value.active.endsWith('/'+agentCliProvider(provider).command))||value.active.length>512||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.active))refuse();
  data={...data,installed:value.installed,managed:value.managed,version:value.version,active:value.active,installationRevision:value.installationRevision};
 }else{
  if(value.operationId!==operationId)refuse();
  const states=action==='status'?['not_found','unknown','preparing','installing','completed','reused','failed']:['completed','reused'];
  if(!states.includes(value.state))refuse();
  if(value.state!=='not_found'){
   if(value.provider!==provider||value.intentDigest!==intentDigest||!stable(value.version)||value.login!=='not_checked')refuse();
   if(action!=='status'&&value.version!==JSON.parse(plan.manifest.argvJson)[2])refuse();
   if(value.cleanupFailures!==undefined&&(!Number.isSafeInteger(value.cleanupFailures)||value.cleanupFailures<=0))refuse();
  }else if(value.cleanupFailures!==undefined)refuse();
  data={...data,state:value.state,operationId,...(value.state==='not_found'?{}:{version:value.version}),...(value.state==='failed'?{error:'INSTALL_FAILED'}:{}),...(value.cleanupFailures===undefined?{}:{cleanupFailures:value.cleanupFailures})};
 }
 return {failed:false,texts:[],data:{agentCli:Object.freeze(data)}};
}
