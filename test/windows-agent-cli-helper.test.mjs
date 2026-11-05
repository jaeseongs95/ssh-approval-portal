import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWindowsCliFixtureScript} from './windows-agent-cli-fixture.mjs';
import {spawnSync} from 'node:child_process';

test('Windows CLI helper의 ACL, 원자적 상태, 출력 제한과 비밀 제거', {skip:process.platform!=='win32'},()=>{
 const script=buildWindowsCliFixtureScript();
 const receiver="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
 const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(receiver,'utf16le').toString('base64')],{input:script,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32768});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 assert.equal(result.stdout.trim(),'ok');
});
