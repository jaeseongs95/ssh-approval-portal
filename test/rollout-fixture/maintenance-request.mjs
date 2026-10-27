import fs from 'node:fs';
export async function requestMaintenance(action,settings,fetchImpl=globalThis.fetch){
 if(!['reserve','release'].includes(action))throw Error('Invalid fixed maintenance action');
 try{
  const response=await fetchImpl('http://127.0.0.1:'+settings.adminPort+'/api/maintenance/'+action,{method:'POST',headers:{Authorization:'Bearer '+settings.adminToken,Origin:settings.adminOrigin},signal:AbortSignal.timeout(5000)});
  const body=await response.json().catch(()=>({}));
  return {action,httpStatus:response.status,confirmed:response.status===200&&body[action==='reserve'?'reserved':'released']===true};
 }catch{return {action,transportFailed:true,confirmed:false};}
}
if(import.meta.main){
 let result={action:process.argv[2],configurationFailed:true,confirmed:false};
 try{const {loadSecrets}=await import('./source/src/adapters/config/secrets.mjs');const{parseSettings}=await import('./source/src/adapters/config/settings.mjs');const settings=parseSettings(await loadSecrets(process.env,'/etc/ssh-mcp-approval-bridge.env'));result=await requestMaintenance(process.argv[2],settings);}catch{}
 fs.appendFileSync(new URL('./maintenance-summary.jsonl',import.meta.url),JSON.stringify(result)+'\n',{mode:0o600});
 if(!result.confirmed)process.exitCode=1;
}
