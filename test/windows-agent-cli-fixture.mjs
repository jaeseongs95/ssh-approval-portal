import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function buildWindowsCliFixtureScript(){
 const source=readFileSync(new URL('../scripts/manage-agent-cli-windows.ps1',import.meta.url),'utf8');
 const library=source.slice(source.indexOf('$ErrorActionPreference'),source.indexOf('function Main'));
 const firstRevision=createHash('sha256').update('{"active":null,"installed":false,"login":"not_checked","managed":false,"provider":"codex","version":null}\n').digest('hex');
 const firstIntegrity='sha512-'+createHash('sha512').update('{"provider":"codex","version":"1.2.3"}').digest('base64');
 const firstIntentDigest=createHash('sha256').update('{"action":"install","expected":"'+firstRevision+'","expires":1900000000000,"integrity":"'+firstIntegrity+'","provider":"codex","version":"1.2.3"}\n').digest('hex');
 return `${library}
function Assert($ok,$name) { if(-not $ok) { throw $name } }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('cli-helper-test-'+[Guid]::NewGuid().ToString('N'))
$fixtureStage='private-root'
try {
 PrivateDirectory $testRoot
 $homeDirectory=$testRoot
 $fixtureStage='atomic-state'
 $statePath=Join-Path $testRoot 'state.json'
 AtomicJson $statePath @{value=1}; AtomicJson $statePath @{value=2}
 Assert ((ReadJson $statePath).value -eq 2) 'atomic-state'
 Assert ((Get-Acl -LiteralPath $statePath).GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $accountSid) 'state-selected-account-owner'
 $acl=Get-Acl -LiteralPath $statePath
 Assert $acl.AreAccessRulesProtected 'state-private-acl'
 Assert ((Digest ([ordered]@{a=1;b=2})) -eq (HashBytes ($utf8.GetBytes("{\`"a\`":1,\`"b\`":2}\`n")))) 'canonical-digest'
 $fixtureStage='process-boundaries'
 $node=(Get-Command node.exe -ErrorAction Stop).Source
 $env:OPENAI_API_KEY='must-not-leak';$env:ANTHROPIC_API_KEY='must-not-leak'
 $result=[AgentCliProcess]::Run($node,@('-e','process.stdout.write(JSON.stringify({a:process.env.OPENAI_API_KEY,b:process.env.ANTHROPIC_API_KEY}))'),$testRoot,(EnvironmentFor $testRoot ([IO.Path]::GetDirectoryName($node))),15000,1024)
 Assert ($result[0] -eq 0 -and $result[1] -eq '{}') 'clean-environment'
 $rejected=$false
 try { $null=[AgentCliProcess]::Run($node,@('-e','process.stdout.write("x".repeat(100000))'),$testRoot,(EnvironmentFor $testRoot),15000,128) } catch { $rejected=$true }
 Assert $rejected 'output-limit'
 $rejected=$false
 try { $null=[AgentCliProcess]::Run($node,@('-e','setTimeout(()=>{},60000)'),$testRoot,(EnvironmentFor $testRoot),150,128) } catch { $rejected=$true }
 Assert $rejected 'timeout'
 # Spawn immediately, before any application handshake. The child must inherit
 # the job even when detached and when its parent overflows or times out.
 $spawnChild='const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{detached:true,stdio:"ignore",windowsHide:true});require("node:fs").writeFileSync(process.argv[1],String(c.pid));if(process.argv[2]==="output"){process.stdout.write("x".repeat(100000))}setTimeout(()=>{},60000)'
 foreach ($mode in @('timeout','output')) {
     $childFile=Join-Path $testRoot ('child-'+$mode+'.pid')
     $rejected=$false
     try { $null=[AgentCliProcess]::Run($node,@('-e',$spawnChild,$childFile,$mode),$testRoot,(EnvironmentFor $testRoot),3000,128) }
     catch { $rejected=$_.Exception.ToString() -match $(if($mode -eq 'timeout'){'PROCESS_TIMEOUT'}else{'OUTPUT_LIMIT'}) }
     Assert $rejected ('child-boundary-'+$mode)
     Assert (Test-Path -LiteralPath $childFile) ('child-started-'+$mode)
     $childId=[int][IO.File]::ReadAllText($childFile)
     $child=$null
     try { $child=[Diagnostics.Process]::GetProcessById($childId) } catch [ArgumentException] { }
     if($null -ne $child) {
         try { Assert ($child.WaitForExit(5000)) ('child-terminated-'+$mode) }
         finally { if(-not $child.HasExited){$child.Kill()};$child.Dispose() }
     }
 }
 # A fake npm writes a tiny fixture package; no registry or vendor program runs.
 $testNode=$node
 $fakeNpm=Join-Path $testRoot 'fixture-npm.cjs'
 [IO.File]::WriteAllText($fakeNpm,@'
const fs=require('fs'),path=require('path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const fixture=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));
fs.appendFileSync(path.join(__dirname,'npm-executions.log'),JSON.stringify({provider:fixture.provider,version:fixture.version})+'\\n');
if(fixture.failure){
 fs.mkdirSync(prefix,{recursive:true});fs.writeFileSync(path.join(prefix,'partial-install.txt'),'partial');
 const cache=process.argv[process.argv.indexOf('--cache')+1];fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,'partial-cache.txt'),'partial');
 fs.writeFileSync(path.join(process.env.USERPROFILE,'partial-home.txt'),'partial');
 if(fixture.failure==='timeout'){setTimeout(()=>{},60000);return;}
 process.exit(1);
}
const packageDir=path.join(prefix,'node_modules',fixture.provider==='claude'?'@anthropic-ai':'@openai',fixture.provider==='claude'?'claude-code':'codex');
fs.mkdirSync(path.join(packageDir,'bin'),{recursive:true});
const relative=fixture.provider==='claude'?'bin/claude.exe':'bin/codex.js';
fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({bin:{[fixture.provider]:relative}}));
if(fixture.provider==='claude'){
 fs.copyFileSync(fixture.executable,path.join(packageDir,relative));
 fs.writeFileSync(path.join(packageDir,'bin','version.txt'),fixture.version);
}else{fs.writeFileSync(path.join(packageDir,relative),'console.log("codex-cli '+fixture.version+'")');}
'@,$utf8)
 function ExecutionCount {
     $log=Join-Path $testRoot 'npm-executions.log'
     if([IO.File]::Exists($log)){return [IO.File]::ReadAllLines($log).Length}
     return 0
 }
 function NodeRuntime { return @($testNode,$fakeNpm) }
 $testArchive='{"provider":"codex","version":"1.2.3"}'
 function Download($url,$destination,$deadline) {
     [IO.File]::WriteAllText($destination,$testArchive,$utf8)
     if($script:lockDownload){$script:downloadHandle=[IO.File]::Open($destination,'Open','Read','None')}
 }
 function Integrity { return 'sha512-'+[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($utf8.GetBytes($testArchive))) }
 $env:PATH=[IO.Path]::GetDirectoryName($testNode)
 $fixtureStage='login-environment'
 $environmentProbe=Join-Path $testRoot 'environment-probe.cjs'
 [IO.File]::WriteAllText($environmentProbe,'console.log(JSON.stringify({home:process.env.USERPROFILE,temp:process.env.TEMP,tmp:process.env.TMP,codex:process.env.CODEX_HOME}))',$utf8)
 $loginEnvironment=RunCli $environmentProbe @() $testRoot $true
 Assert ($loginEnvironment[0] -eq 0 -and -not $loginEnvironment[2]) 'login-environment-probe'
 $loginValues=$loginEnvironment[1] | ConvertFrom-Json
 Assert ($loginValues.home -ceq $homeDirectory) 'login-real-home-preserved'
 Assert ($loginValues.temp -ceq (Join-Path $testRoot 'tmp') -and $loginValues.tmp -ceq $loginValues.temp) 'login-private-temporary-directory'
 Assert ($null -eq $loginValues.codex -and -not (Join-Path $loginValues.home '.codex').StartsWith($loginValues.temp,[StringComparison]::OrdinalIgnoreCase)) 'login-home-outside-temporary-directory'
 $root=Join-Path $homeDirectory '.ssh-approval-cli/codex'
 PrivateDirectory (Join-Path $homeDirectory '.codex')
 $credentialFixture=Join-Path $homeDirectory '.codex/auth-fixture.txt'
 [IO.File]::WriteAllText($credentialFixture,'credential-fixture-unchanged',$utf8)
 $before=Inspect $root 'codex'
 $fixtureStage='install'
 $expiry=1900000000000L
 $operation='a'*48
 Assert ($before.installationRevision -ceq '${firstRevision}') 'cross-language-initial-revision'
 Assert ((Integrity) -ceq '${firstIntegrity}') 'cross-language-package-integrity'
 $receipt=Install $root 'install' 'codex' '1.2.3' (Integrity) $before.installationRevision $expiry $operation
 Assert ($receipt.state -eq 'completed') 'fixture-install'
 Assert ($receipt.intentDigest -ceq '${firstIntentDigest}') 'cross-language-install-intent-digest'
 Assert ((Inspect $root 'codex').version -eq '1.2.3') 'fixture-active'
 $executions=ExecutionCount
 Assert ($executions -eq 1) 'first-install-executed-once'
 # Discard the response; recovery receives only the persisted operation ID.
 $receipt=$null
 $recovered=Status $root 'codex' $operation
 Assert ($recovered.state -eq 'completed' -and $recovered.version -eq '1.2.3' -and $recovered.operationId -eq $operation) 'lost-response-receipt-read'
 Assert ((ExecutionCount) -eq $executions) 'lost-response-read-does-not-install'
 Assert ((Install $root 'install' 'codex' '1.2.3' (Integrity) $before.installationRevision $expiry $operation).state -eq 'completed') 'receipt-no-replay'
 Assert ((ExecutionCount) -eq $executions) 'same-intent-does-not-execute'
 $fixtureStage='different-intent'
 $rejected=$false
 try { $null=Install $root 'install' 'codex' '1.2.9' (Integrity) $before.installationRevision $expiry $operation }
 catch { $rejected=$_.Exception.ToString() -match 'REQUEST_CONFLICT' }
 Assert $rejected 'same-operation-different-intent-refused'
 Assert ((ExecutionCount) -eq $executions) 'different-intent-execution-count-unchanged'
 Assert ((Status $root 'codex' $operation).intentDigest -eq $recovered.intentDigest) 'different-intent-receipt-unchanged'
 $oldActive=(ReadJson (Join-Path $root 'current.json')).active
 $before=Inspect $root 'codex'
 $fixtureStage='update'
 $testArchive='{"provider":"codex","version":"1.2.4"}'
 $receipt=Install $root 'update' 'codex' '1.2.4' (Integrity) $before.installationRevision $expiry ('b'*48)
 Assert ($receipt.state -eq 'completed' -and (Inspect $root 'codex').version -eq '1.2.4') 'fixture-update'
 Assert (Test-Path -LiteralPath (Join-Path $root $oldActive)) 'previous-version-retained'
 $fixtureStage='exclusive-lock'
 $executions=ExecutionCount
 $lockedBefore=Inspect $root 'codex'
 $exclusive=[IO.File]::Open((Join-Path $root '.lock'),'Open','ReadWrite','None')
 try {
     $rejected=$false
     try { $null=Install $root 'update' 'codex' '1.2.4' (Integrity) $lockedBefore.installationRevision $expiry ('2'*48) }
     catch { $rejected=$_.Exception.ToString() -match 'BUSY' }
     Assert $rejected 'live-exclusive-lock-refused'
     Assert ((ExecutionCount) -eq $executions) 'live-lock-execution-count-unchanged'
     Assert (-not (Test-Path -LiteralPath (Join-Path $root ('operations/'+('2'*48))))) 'live-lock-no-operation-created'
 } finally { $exclusive.Dispose() }
 Assert ((Inspect $root 'codex').installationRevision -eq $lockedBefore.installationRevision) 'live-lock-active-unchanged'
 $rejected=$false
 try { $null=Install $root 'update' 'codex' '1.2.4' (Integrity) $before.installationRevision $expiry ('c'*48) } catch { $rejected=$true }
 Assert $rejected 'stale-revision'
 $before=Inspect $root 'codex'
 $fixtureStage='failure-cleanup'
 $successfulReceiptPath=Join-Path $root ('operations/'+('b'*48)+'/receipt.json')
 $successfulReceiptHash=(Get-FileHash -LiteralPath $successfulReceiptPath -Algorithm SHA256).Hash
 $stableCurrentHash=(Get-FileHash -LiteralPath (Join-Path $root 'current.json') -Algorithm SHA256).Hash
 $protectedFiles=@()
 foreach($active in @($oldActive,$before.active)){
     $prefix=Join-Path $root $active
     foreach($path in @((PackageExecutable $prefix 'codex'),(Join-Path $prefix '.installed.json'))){$protectedFiles+=@{path=$path;hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}}
 }
 $unrelatedWork=Join-Path $root ('operations/'+('e'*48));PrivateDirectory $unrelatedWork
 $unrelatedPayload=Join-Path $unrelatedWork 'keep.txt';[IO.File]::WriteAllText($unrelatedPayload,'unrelated-work-preserved',$utf8)
 AtomicJson (Join-Path $unrelatedWork 'receipt.json') @{provider='codex';operationId=('e'*48);intentDigest=('e'*64);state='preparing';version='1.2.9';login='not_checked'}
 $unrelatedReceiptHash=(Get-FileHash -LiteralPath (Join-Path $unrelatedWork 'receipt.json') -Algorithm SHA256).Hash
 function AssertFailurePreserved($operation,$name,[bool]$restored=$true) {
     $executed=ExecutionCount
     $failed=Status $root 'codex' $operation
     Assert ($failed.state -ceq 'failed' -and $failed.operationId -ceq $operation) ($name+'-failed-receipt')
     Assert ((ExecutionCount) -eq $executed) ($name+'-status-does-not-reinstall')
     Assert ((Get-FileHash -LiteralPath $successfulReceiptPath -Algorithm SHA256).Hash -ceq $successfulReceiptHash) ($name+'-original-receipt-preserved')
     Assert ((Get-FileHash -LiteralPath (Join-Path $unrelatedWork 'receipt.json') -Algorithm SHA256).Hash -ceq $unrelatedReceiptHash) ($name+'-other-receipt-preserved')
     Assert ([IO.File]::ReadAllText($unrelatedPayload) -ceq 'unrelated-work-preserved') ($name+'-other-work-preserved')
     Assert ([IO.File]::ReadAllText($credentialFixture) -ceq 'credential-fixture-unchanged') ($name+'-credentials-preserved')
     Assert (Test-Path -LiteralPath (Join-Path $root $oldActive)) ($name+'-previous-version-preserved')
     foreach($protected in $protectedFiles){Assert ((Get-FileHash -LiteralPath $protected.path -Algorithm SHA256).Hash -ceq $protected.hash) ($name+'-active-and-previous-bytes-preserved')}
     if($restored){Assert ((Get-FileHash -LiteralPath (Join-Path $root 'current.json') -Algorithm SHA256).Hash -ceq $stableCurrentHash) ($name+'-current-preserved')}
     $released=[IO.File]::Open((Join-Path $root '.lock'),'Open','ReadWrite','None');$released.Dispose()
 }
 function AssertWorkClean($operation,$name) {
     $entries=@(Get-ChildItem -LiteralPath (Join-Path $root ('operations/'+$operation)) -Force)
     Assert ($entries.Count -eq 1 -and $entries[0].Name -ceq 'receipt.json') ($name+'-only-receipt-remains')
 }
 $testArchive='{"provider":"codex","version":"1.2.5"}'
 $rejected=$false
 try { $null=Install $root 'update' 'codex' '1.2.5' ('sha512-'+[Convert]::ToBase64String((New-Object byte[] 64))) $before.installationRevision $expiry ('f'*48) } catch { $rejected=$true }
 Assert ($rejected -and (Inspect $root 'codex').version -eq '1.2.4') 'integrity-before-activation'
 AssertFailurePreserved ('f'*48) 'integrity'
 AssertWorkClean ('f'*48) 'integrity'
 foreach($mode in @('npm','timeout')) {
     $fixtureStage='failure-cleanup-'+$mode
     $failureOperation=$(if($mode -eq 'npm'){'5'*48}else{'6'*48})
     $testArchive=Json @{provider='codex';version='1.2.5';failure=$mode}
     $failureExpiry=$(if($mode -eq 'timeout'){[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+5000}else{$expiry})
     $executed=ExecutionCount;$rejected=$false
     try{$null=Install $root 'update' 'codex' '1.2.5' (Integrity) $before.installationRevision $failureExpiry $failureOperation}
     catch{$rejected=$_.Exception.ToString() -match 'INSTALL_FAILED'}
     Assert ($rejected -and (ExecutionCount) -eq ($executed+1)) ($mode+'-actual-npm-started-and-failed')
     AssertFailurePreserved $failureOperation $mode
     AssertWorkClean $failureOperation $mode
 }
 # Keep an exclusive handle to our downloaded payload: deletion must fail
 # observably without concealing the residue or touching another operation.
 $fixtureStage='failure-cleanup-locked-payload'
 $testArchive='{"provider":"codex","version":"1.2.5"}'
 $script:lockDownload=$true;$script:downloadHandle=$null
 try {
     $rejected=$false
     try{$null=Install $root 'update' 'codex' '1.2.5' ('sha512-'+[Convert]::ToBase64String((New-Object byte[] 64))) $before.installationRevision $expiry ('7'*48)}catch{$rejected=$true}
     Assert $rejected 'locked-payload-install-refused'
     AssertFailurePreserved ('7'*48) 'locked-payload'
     $lockedStatus=Status $root 'codex' ('7'*48)
     Assert ($lockedStatus.cleanupFailures -gt 0) 'locked-payload-cleanup-diagnostic'
     Assert ([IO.File]::Exists((Join-Path $root ('operations/'+('7'*48)+'/package.tgz')))) 'locked-payload-residue-observed-before-fixture-finally'
 } finally {if($null -ne $script:downloadHandle){$script:downloadHandle.Dispose()};$script:lockDownload=$false}
 # Fail immediately after the production activation, then verify rollback
 # before any fixture-wide cleanup can hide a leaked prefix or new version.
 $savedCleanup=\${function:Cleanup}
 try {
     function Cleanup { throw 'FIXTURE_AFTER_ACTIVATION' }
     $fixtureStage='failure-cleanup-after-activation'
     $testArchive='{"provider":"codex","version":"1.2.6"}'
     $newTarget='versions/1.2.6-'+(HashBytes ($utf8.GetBytes((Integrity)))).Substring(0,16)
     $rejected=$false
     try{$null=Install $root 'update' 'codex' '1.2.6' (Integrity) $before.installationRevision $expiry ('8'*48)}catch{$rejected=$_.Exception.ToString() -match 'INSTALL_FAILED'}
     Assert $rejected 'post-activation-refused'
     AssertFailurePreserved ('8'*48) 'post-activation'
     AssertWorkClean ('8'*48) 'post-activation'
     Assert (-not (Test-Path -LiteralPath (Join-Path $root $newTarget))) 'post-activation-own-new-version-reclaimed'
     $fixtureStage='failure-cleanup-unknown-recovery'
     $savedAtomicJson=\${function:AtomicJson};$rollbackTarget=$before.active
     try {
         function AtomicJson($path,$value) {
             if($path -ceq (Join-Path $root 'current.json') -and $value.active -ceq $rollbackTarget){throw 'FIXTURE_ROLLBACK_FAILED'}
             & $savedAtomicJson $path $value
         }
         $testArchive='{"provider":"codex","version":"1.2.7"}'
         $recoveryTarget='versions/1.2.7-'+(HashBytes ($utf8.GetBytes((Integrity)))).Substring(0,16)
         $rejected=$false
         try{$null=Install $root 'update' 'codex' '1.2.7' (Integrity) $before.installationRevision $expiry ('9'*48)}catch{$rejected=$_.Exception.ToString() -match 'RECOVERY_REQUIRED'}
         Assert $rejected 'unknown-recovery-refused'
         AssertFailurePreserved ('9'*48) 'unknown-recovery' $false
         AssertWorkClean ('9'*48) 'unknown-recovery'
         Assert ((ReadJson (Join-Path $root 'current.json')).active -ceq $recoveryTarget) 'unknown-recovery-active-pointer-preserved'
         Assert (Test-Path -LiteralPath (Join-Path (Join-Path $root $recoveryTarget) '.installed.json')) 'unknown-recovery-version-and-metadata-preserved'
         Assert ((Status $root 'codex' ('9'*48)).cleanupFailures -gt 0) 'unknown-recovery-retention-diagnostic'
     } finally {Set-Item -Path Function:AtomicJson -Value $savedAtomicJson}
     AtomicJson (Join-Path $root 'current.json') @{active=$before.active}
 } finally {Set-Item -Path Function:Cleanup -Value $savedCleanup}
 Assert ([IO.File]::ReadAllText($credentialFixture) -eq 'credential-fixture-unchanged') 'credentials-preserved'
 $testArchive='{"provider":"codex","version":"1.2.5"}'
 $externalPrefix=Join-Path $homeDirectory 'AppData/Roaming/npm'
 $fixtureStage='external-reuse'
 $externalArchive=Join-Path $testRoot 'external.json'; [IO.File]::WriteAllText($externalArchive,$testArchive,$utf8)
 $null=[AgentCliProcess]::Run($testNode,@($fakeNpm,'--prefix',$externalPrefix,$externalArchive),$testRoot,(EnvironmentFor $testRoot),15000,1024)
 $externalRoot=Join-Path $homeDirectory '.ssh-approval-cli/external-fixture'
 $externalBefore=Inspect $externalRoot 'codex'
 Assert ($externalBefore.installed -and -not $externalBefore.managed -and $externalBefore.version -eq '1.2.5') 'external-detection'
 $receipt=Install $externalRoot 'install' 'codex' '1.2.5' (Integrity) $externalBefore.installationRevision $expiry ('1'*48)
 Assert ($receipt.state -eq 'reused' -and -not (Test-Path -LiteralPath (Join-Path $externalRoot 'current.json'))) 'external-reuse'
 $pending=Join-Path $root ('operations/'+('d'*48)); PrivateDirectory $pending
 AtomicJson (Join-Path $pending 'receipt.json') @{provider='codex';operationId=('d'*48);intentDigest=('e'*64);state='installing';version='1.2.4';login='not_checked'}
 Assert ((Status $root 'codex' ('d'*48)).state -eq 'unknown') 'interrupted-install-unknown'
 $fixtureStage='claude-install'
 $claudeExecutable=Join-Path $testRoot 'fixture-claude.exe'
 Add-Type -OutputType ConsoleApplication -OutputAssembly $claudeExecutable -TypeDefinition @'
using System;
using System.IO;
public static class FixtureClaudeCli {
 public static void Main(string[] args) { Console.WriteLine(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"version.txt"))+" (Claude Code)"); }
}
'@
 $claudeRoot=Join-Path $homeDirectory '.ssh-approval-cli/claude'
 $testArchive=Json ([ordered]@{provider='claude';version='2.1.1';executable=$claudeExecutable})
 $claudeBefore=Inspect $claudeRoot 'claude'
 $executions=ExecutionCount
 $claudeReceipt=Install $claudeRoot 'install' 'claude' '2.1.1' (Integrity) $claudeBefore.installationRevision $expiry ('3'*48)
 Assert ($claudeReceipt.state -eq 'completed' -and $claudeReceipt.provider -eq 'claude') 'claude-install-receipt'
 Assert ((ExecutionCount) -eq ($executions+1)) 'claude-install-executed-once'
 $claudeInstalled=Inspect $claudeRoot 'claude'
 Assert ($claudeInstalled.managed -and $claudeInstalled.installed -and $claudeInstalled.version -eq '2.1.1') 'claude-inspect-installed'
 $claudePackage=Join-Path (Join-Path $claudeRoot $claudeInstalled.active) 'node_modules/@anthropic-ai/claude-code'
 $claudeMetadata=$utf8.GetString([IO.File]::ReadAllBytes((Join-Path $claudePackage 'package.json'))) | ConvertFrom-Json
 Assert ($claudeMetadata.bin.claude -eq 'bin/claude.exe') 'claude-package-native-bin-layout'
 Assert ((PackageExecutable (Join-Path $claudeRoot $claudeInstalled.active) 'claude') -eq [IO.Path]::GetFullPath((Join-Path $claudePackage 'bin/claude.exe'))) 'claude-selected-executable'
 Assert ((Status $claudeRoot 'claude' ('3'*48)).state -eq 'completed') 'claude-install-status'
 $fixtureStage='claude-update'
 $testArchive=Json ([ordered]@{provider='claude';version='2.1.2';executable=$claudeExecutable})
 $claudeReceipt=Install $claudeRoot 'update' 'claude' '2.1.2' (Integrity) $claudeInstalled.installationRevision $expiry ('4'*48)
 Assert ($claudeReceipt.state -eq 'completed' -and $claudeReceipt.version -eq '2.1.2') 'claude-update-receipt'
 $claudeUpdated=Inspect $claudeRoot 'claude'
 Assert ($claudeUpdated.managed -and $claudeUpdated.version -eq '2.1.2' -and $claudeUpdated.active -ne $claudeInstalled.active) 'claude-update-active'
 $claudeStatus=Status $claudeRoot 'claude' ('4'*48)
 Assert ($claudeStatus.state -eq 'completed' -and $claudeStatus.provider -eq 'claude' -and $claudeStatus.version -eq '2.1.2') 'claude-update-status'
 Assert ((ExecutionCount) -eq ($executions+2)) 'claude-update-executed-once'
 [Console]::Out.WriteLine('ok')
} catch { [Console]::Error.WriteLine('CLI_FIXTURE_STAGE='+$fixtureStage); throw
} finally { if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force} }
`;
}
