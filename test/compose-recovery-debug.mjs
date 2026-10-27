// Synthetic CI diagnostic: report status and bounded nonsecret summary only.
import { readFileSync } from 'node:fs';
import { loadSecrets } from '../src/adapters/config/secrets.mjs';
import { parseSettings } from '../src/adapters/config/settings.mjs';
const owner=readFileSync(0,'utf8').trim();
const env=await loadSecrets(process.env,process.env.BRIDGE_SECRET_ENV_FILE);
const {adminPort}=parseSettings(env);
for(const action of ['capabilities','preservation/compare']) {
  try {
    const response=await fetch(`http://127.0.0.1:${adminPort}/api/maintenance/${action}`,{
      method:'POST',headers:{Authorization:'Bearer '+env.BRIDGE_ADMIN_TOKEN,Origin:env.BRIDGE_ADMIN_ORIGIN,'X-Maintenance-Owner':owner},signal:AbortSignal.timeout(5000),
    });
    const body=await response.json();
    console.log(JSON.stringify({action,httpStatus:response.status,status:body.status??null,ownership:body.ownership??null}));
  } catch(error) { console.log(JSON.stringify({action,errorType:error.name})); }
}
