// Native protocol/claim fixture only: no real credentials, HTTP or SSH.
import { appendFile } from 'node:fs/promises';
import { loadFileManifest, createFileForwarder } from '../src/adapters/cli/file-forwarder.mjs';
import { startFileMcp } from '../scripts/portal-file-mcp.mjs';
const [manifestPath,journalRoot,log,mode]=process.argv.slice(2);
if(process.argv.length!==6||!['normal','unknown','crash'].includes(mode))throw Error('INVALID_OWNED_FIXTURE');
const manifest=await loadFileManifest(manifestPath),cap=manifest.capabilities[0],transferId='b'.repeat(48),requestId='c'.repeat(48);
const note=effect=>appendFile(log,JSON.stringify({effect,capabilityId:cap.id})+'\n',{encoding:'utf8',mode:0o600});
const job={id:requestId,kind:'upload',state:'pending',operation:{kind:'upload',artifactId:transferId,remotePath:cap.remotePath,elevate:cap.elevate,overwrite:cap.overwrite,size:cap.size,sha256:cap.sha256,fileTargetId:cap.target,fileTargetRevision:cap.targetRevision}};
const forwarder=await createFileForwarder({manifest,journalRoot,openClient:async()=>({
 async targets(){return {targets:[{id:cap.target,enabled:true,revision:cap.targetRevision}]};},
 async upload(_source,_intent,ack){await note('upload');if(mode==='crash')process.exit(23);if(mode==='unknown')throw Error('PRIVATE-native-fixture-value');await ack({transferId});return job;},
 async resumeUpload(id){if(id!==transferId)throw Error('WRONG_ID');await note('resume');return job;},
 async status(id){if(id!==requestId)throw Error('WRONG_ID');await note('status');return job;},
 async transfer(id){if(id!==transferId)throw Error('WRONG_ID');return{job};},
 async close(){},
})});
await startFileMcp({forwarder});
