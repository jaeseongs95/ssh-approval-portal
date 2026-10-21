import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('BRIDGE-CLI-RUNTIME actual entrypoint enables owner CLI without remote calls or automation changes',()=>{
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./bridge-cli-runtime.fixture.mjs',import.meta.url))],{encoding:'utf8',timeout:15000,windowsHide:true});
 assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stdout+r.stderr);
 const receipt=r.stdout.trim().split('\n').map(x=>JSON.parse(x)).find(x=>x.actualBridge);
 assert.equal(receipt.status,'PASS');assert.equal(receipt.realApplication,true);assert.equal(receipt.available,true);assert.equal(receipt.sshCalls,0);assert.equal(receipt.modelCalls,0);
});
