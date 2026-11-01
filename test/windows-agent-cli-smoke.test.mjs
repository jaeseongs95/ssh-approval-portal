import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {win32} from 'node:path';
import {createSshRuntime} from '../src/adapters/ssh/vendor.mjs';
import {prepareAgentCliPlan} from '../src/adapters/ssh/agent-cli.mjs';
import {validateAgentRelease} from '../src/domain/agent-cli.mjs';
import {wrapWindowsCommand} from '../src/domain/target-platform.mjs';

// Official registry metadata checked on 2026-11-01. Execution never resolves
// latest: both tarball bytes and versions below are immutable test inputs.
const releases=Object.freeze([
 {provider:'codex',name:'@openai/codex',version:'0.166.0',integrity:'sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q=='},
 {provider:'claude',name:'@anthropic-ai/claude-code',version:'2.1.316',integrity:'sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ=='},
]);
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const enabled=process.env.AGS_WINDOWS_CLI_PACKAGE_SMOKE==='1';

test('고정 공식 npm 패키지를 격리 Windows SSH 계정에 설치하고 버전·상태를 확인한다',{
 skip:!enabled,timeout:1_950_000,
},async t=>{
 assert.equal(process.platform,'win32');
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 assert.ok(process.env.AGS_WINDOWS_SSH_FIXTURE,'격리 SSH 시험 설정이 필요함');
 const fixture=JSON.parse(await readFile(process.env.AGS_WINDOWS_SSH_FIXTURE,'utf8'));
 const isolation=fixture.cliSmokeIsolation;
 assert.equal(isolation?.ephemeral,true,'임시 계정 표시가 없으면 설치하지 않음');
 assert.match(isolation.accountName,/^agsci[a-f0-9]{12}$/);
 assert.match(isolation.accountSid,/^S-1-5-21-[0-9-]+$/);
 assert.equal(win32.isAbsolute(isolation.nodeExecutable),true);
 assert.equal(win32.basename(isolation.nodeExecutable).toLowerCase(),'node.exe');
 const settings={BRIDGE_CONFIG_PATH:fixture.configPath,BRIDGE_HOST_KEY_MODE:'strict'};
 let runtime=await createSshRuntime(settings),previousUserPath,pathPrepared=false;
 const binding={targetId:'windows-cli-smoke',targetRevision:'9'.repeat(64),profile:'windows-write',platform:'windows'};
 const raw=async script=>{
  const connection=await runtime.registry.getOrCreate(binding.profile);
  // 새 격리 계정의 최초 모듈 준비 진행 출력만 억제한다. 오류 스트림 검사는 유지한다.
  const result=await connection.exec(wrapWindowsCommand("$global:ProgressPreference='SilentlyContinue';"+script));
  assert.equal(result.exitCode,0,result.stderr);assert.equal(result.stderr,'');
  return JSON.parse(result.stdout);
 };
 try{
  const profile=runtime.registry.getProfile(binding.profile);
  assert.equal(profile.user,isolation.accountName);
  assert.equal(profile.host,'127.0.0.1');
  assert.equal(profile.tty,false);assert.equal(profile.readOnly,false);
  const accountGuard=`$i=[Security.Principal.WindowsIdentity]::GetCurrent();if($i.User.Value -cne ${literal(isolation.accountSid)}){throw '계정 불일치'};$p=[Security.Principal.WindowsPrincipal]::new($i);if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw '비관리자 계정이 필요함'};`;
  // File existence only; no credential content, key, token or environment dump.
  const before=await raw(accountGuard+`$h=[Environment]::GetFolderPath('UserProfile');$existing=$false;foreach($p in @('.codex/auth.json','.claude/.credentials.json','.claude.json')){if([IO.File]::Exists([IO.Path]::Combine($h,$p))){$existing=$true}};[Console]::WriteLine((@{credentialsExist=$existing}|ConvertTo-Json -Compress))`);
  assert.equal(before.credentialsExist,false,'기존 로그인 자료가 있으면 설치하지 않음');
  for(const release of releases){
   const before=await runtime.executeAgentCli(prepareAgentCliPlan({action:'inspect',provider:release.provider,binding}),()=>binding);
   assert.equal(before.failed,false);assert.equal(before.data.agentCli.installed,false,'기존 CLI 설치가 있으면 변경하지 않음');
  }
  const nodeDirectory=win32.dirname(isolation.nodeExecutable);
  const prepared=await raw(accountGuard+`if(-not [IO.File]::Exists(${literal(isolation.nodeExecutable)})){throw '지정 Node 실행 파일 없음'};$old=[Environment]::GetEnvironmentVariable('Path','User');[Environment]::SetEnvironmentVariable('Path',${literal(nodeDirectory+';')}+$old,'User');[Console]::WriteLine((@{previousUserPath=$old}|ConvertTo-Json -Compress))`);
  previousUserPath=prepared.previousUserPath??null;pathPrepared=true;
  await runtime.registry.closeAll();runtime=await createSshRuntime(settings);
  // Observe the production runtime selector without replacing any helper function.
  // Installation below still enters the complete fixed helper through Main/SSH.
  const helper=readFileSync(new URL('../scripts/manage-agent-cli-windows.ps1',import.meta.url),'utf8');
  const library=helper.slice(helper.indexOf('$ErrorActionPreference'),helper.indexOf('function Main'));
  const probePath=win32.join(fixture.fileRoot,'cli-runtime-preflight.ps1');
  await writeFile(probePath,library+'\n'+accountGuard+`
$selected=NodeRuntime
$ordered=@(@{origin='system';node=(Join-Path $env:ProgramFiles 'nodejs/node.exe')},@{origin='user';node=(Join-Path $homeDirectory 'AppData/Local/Programs/nodejs/node.exe')})
foreach($directory in ($env:PATH -split ';')){if($directory -and [IO.Path]::IsPathRooted($directory)){$ordered+=@{origin='path';node=(Join-Path $directory 'node.exe')}}}
$seen=@{};$candidates=@()
foreach($candidate in $ordered){
 $key=[IO.Path]::GetFullPath($candidate.node).ToLowerInvariant()
 if($seen.ContainsKey($key)){continue};$seen[$key]=$true
 $npm=Join-Path ([IO.Path]::GetDirectoryName($candidate.node)) 'node_modules/npm/bin/npm-cli.js'
 if([IO.File]::Exists($candidate.node) -and [IO.File]::Exists($npm)){$candidates+=@{origin=$candidate.origin;node=$candidate.node}}
}
$firstCommand=@(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source
$prepared=${literal(isolation.nodeExecutable)}
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('cli-runtime-probe-'+[Guid]::NewGuid().ToString('N'));PrivateDirectory $temporary
try{
 $selectedResult=[AgentCliProcess]::Run($selected[0],@('--version'),$temporary,(EnvironmentFor $temporary ([IO.Path]::GetDirectoryName($selected[0]))),10000,256)
 $preparedResult=[AgentCliProcess]::Run($prepared,@('--version'),$temporary,(EnvironmentFor $temporary ([IO.Path]::GetDirectoryName($prepared))),10000,256)
 Require ($selectedResult[0] -eq 0 -and -not $selectedResult[2] -and $preparedResult[0] -eq 0 -and -not $preparedResult[2]) 'NODE_VERSION_UNAVAILABLE'
 [Console]::Out.WriteLine((Json @{selected=$selected[0];selectedVersion=$selectedResult[1].Trim();prepared=$prepared;preparedVersion=$preparedResult[1].Trim();firstCommand=$firstCommand;candidates=$candidates}))
}finally{Remove-Item -LiteralPath $temporary -Recurse -Force}
`,'utf8');
  const probeConnection=await runtime.registry.getOrCreate(binding.profile);
  const probe=await probeConnection.exec(`powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${probePath}"`,{timeoutMs:30_000});
  assert.equal(probe.exitCode,0,probe.stderr);assert.equal(probe.stderr,'');
  const resolved=JSON.parse(probe.stdout),normalize=value=>win32.normalize(value).toLowerCase();
  assert.equal(typeof resolved.selected,'string');assert.equal(typeof resolved.firstCommand,'string');
  assert.ok(Array.isArray(resolved.candidates)&&resolved.candidates.length>0);
  assert.equal(normalize(resolved.selected),normalize(resolved.candidates[0].node),'생산 NodeRuntime 선택이 실제 후보 우선순위와 다름');
  const preparedIndex=resolved.candidates.findIndex(candidate=>normalize(candidate.node)===normalize(isolation.nodeExecutable));
  assert.ok(preparedIndex>=0,'새 SSH 계정 환경에 준비한 Node/npm 후보가 없음');
  t.diagnostic(JSON.stringify({runtimeSelected:resolved.selected,runtimeVersion:resolved.selectedVersion,runtimeOrigin:resolved.candidates[0].origin,preparedNode:resolved.prepared,preparedVersion:resolved.preparedVersion,preparedCandidateIndex:preparedIndex,firstShellCommand:resolved.firstCommand}));
  assert.match(resolved.selectedVersion,/^v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/);
  assert.match(resolved.preparedVersion,/^v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/);
  for(const entry of releases){
   await t.test(entry.provider+' 고정 배포물 설치·버전·로그인 진단',async()=>{
    const tarball='https://registry.npmjs.org/'+entry.name+'/-/'+entry.name.split('/')[1]+'-'+entry.version+'.tgz';
    const release=validateAgentRelease(entry.provider,{name:entry.name,version:entry.version,dist:{tarball,integrity:entry.integrity}});
    const before=await runtime.executeAgentCli(prepareAgentCliPlan({action:'inspect',provider:entry.provider,binding}),()=>binding);
    assert.equal(before.failed,false);assert.equal(before.data.agentCli.installed,false);
    const plan=prepareAgentCliPlan({action:'install',provider:entry.provider,binding,release,expectedInstallationRevision:before.data.agentCli.installationRevision,expiresAt:Date.now()+900_000,operationId:randomBytes(24).toString('hex')});
    let installed;
    try{installed=await runtime.executeAgentCli(plan,()=>binding);}
    catch(error){
     // A lost reply grants a receipt read only; never replay the installation.
     try{
      const status=await runtime.executeAgentCli(prepareAgentCliPlan({action:'status',provider:entry.provider,binding,operationId:plan.agentCli.operationId,expectedIntentDigest:plan.agentCli.intentDigest}),()=>binding);
      t.diagnostic(JSON.stringify({provider:entry.provider,version:entry.version,receiptState:status.data.agentCli.state}));
     }catch{t.diagnostic(entry.provider+' 설치 결과의 영수증도 확인하지 못함');}
     throw error;
    }
    assert.equal(installed.failed,false);assert.equal(installed.data.agentCli.state,'completed');
    // Production Main -> Install -> NodeRuntime/npm -> VersionOf(--version)
    // must complete before activation. No helper function or downloader is replaced.
    assert.equal(installed.data.agentCli.version,entry.version);
    const inspected=await runtime.executeAgentCli(prepareAgentCliPlan({action:'inspect',provider:entry.provider,binding}),()=>binding);
    assert.equal(inspected.failed,false);assert.equal(inspected.data.agentCli.managed,true);assert.equal(inspected.data.agentCli.version,entry.version);
    const login=await runtime.executeAgentCli(prepareAgentCliPlan({action:'login-status',provider:entry.provider,binding}),()=>binding);
    assert.equal(login.failed,false);assert.equal(login.data.agentCli.state,'signed_out');
    t.diagnostic(JSON.stringify({provider:entry.provider,version:entry.version,installed:true,managed:true,login:'signed_out'}));
   });
  }
 }finally{
  try{if(pathPrepared){
   // Restore this disposable account's setting; never touch machine or runner PATH.
   const restore=previousUserPath===null?'$null':literal(previousUserPath);
   await raw(`if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne ${literal(isolation.accountSid)}){throw '계정 불일치'};[Environment]::SetEnvironmentVariable('Path',${restore},'User');[Console]::WriteLine('{}')`);
  }}finally{await runtime.registry.closeAll();}
 }
});
