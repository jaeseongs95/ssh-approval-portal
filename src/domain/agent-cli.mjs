import {createHash} from 'node:crypto';

export const AGENT_CLI_CONTRACT='agent-cli-install-v1';

const catalog=Object.freeze({
  codex:Object.freeze({id:'codex',packageName:'@openai/codex',command:'codex'}),
  claude:Object.freeze({id:'claude',packageName:'@anthropic-ai/claude-code',command:'claude'}),
});
const digest=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const stable=/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const hex=/^[a-f0-9]{64}$/;

export const agentCliProviders=()=>Object.values(catalog);
export function agentCliProvider(id) {
  if(typeof id!=='string'||!Object.hasOwn(catalog,id))throw Error('Unsupported CLI provider');
  return catalog[id];
}

/** Metadata is untrusted; only these public distribution fields enter a plan. */
export function validateAgentRelease(provider,metadata) {
  const entry=agentCliProvider(provider);
  if(!record(metadata)||metadata.name!==entry.packageName||typeof metadata.version!=='string'||!stable.test(metadata.version)||!record(metadata.dist))throw Error('Invalid CLI release');
  const version=metadata.version;
  const tarball='https://registry.npmjs.org/'+entry.packageName+'/-/'+entry.packageName.split('/')[1]+'-'+version+'.tgz';
  if(metadata.dist.tarball!==tarball)throw Error('Untrusted CLI distribution URL');
  const integrity=metadata.dist.integrity;
  if(typeof integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))throw Error('Invalid CLI distribution integrity');
  const bytes=Buffer.from(integrity.slice(7),'base64');
  if(bytes.length!==64||'sha512-'+bytes.toString('base64')!==integrity)throw Error('Invalid CLI distribution integrity');
  const fields={provider,packageName:entry.packageName,version,tarball,integrity};
  return Object.freeze({...fields,releaseDigest:digest(fields)});
}

/** A fixed intent binds what to install; it never grants execution authority. */
export function agentCliIntent(body,{binding,release,expiresAt,now=Date.now()}) {
  const keys=['targetId','targetRevision','profile','provider','action','releaseDigest','expectedInstallationRevision','requestKey'];
  if(!record(body)||Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k)))throw Error('Invalid CLI request fields');
  agentCliProvider(body.provider);
  if(!['install','update'].includes(body.action))throw Error('Invalid CLI action');
  if(!record(binding)||binding.enabled!==true||!/^[a-z][a-z0-9_-]{0,31}$/.test(binding.targetId??'')||!hex.test(binding.targetRevision??'')||!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/.test(binding.profile??''))throw Error('Invalid CLI target binding');
  if(body.targetId!==binding.targetId||body.targetRevision!==binding.targetRevision||body.profile!==binding.profile)throw Error('Stale CLI target binding');
  if(!record(release))throw Error('Invalid CLI release plan');
  const checked=validateAgentRelease(body.provider,{name:release.packageName,version:release.version,dist:{tarball:release.tarball,integrity:release.integrity}});
  if(checked.releaseDigest!==release.releaseDigest||release.provider!==body.provider||body.releaseDigest!==checked.releaseDigest)throw Error('CLI release plan changed');
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw Error('CLI release plan expired');
  if(typeof body.expectedInstallationRevision!=='string'||!hex.test(body.expectedInstallationRevision))throw Error('CLI installation revision required');
  if(typeof body.requestKey!=='string'||!/^[A-Za-z0-9_.:-]{16,128}$/.test(body.requestKey))throw Error('Invalid CLI request key');
  const fields={contract:'agent-cli-install-v1',targetId:body.targetId,targetRevision:body.targetRevision,profile:body.profile,provider:body.provider,action:body.action,releaseDigest:checked.releaseDigest,expectedInstallationRevision:body.expectedInstallationRevision,expiresAt};
  return Object.freeze({...fields,intentDigest:digest(fields),requestKey:body.requestKey});
}
