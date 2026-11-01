import {readFileSync} from 'node:fs';

export function buildWindowsCliFixtureScript(){
 const source=readFileSync(new URL('../scripts/manage-agent-cli-windows.ps1',import.meta.url),'utf8');
 const library=source.slice(source.indexOf('$ErrorActionPreference'),source.indexOf('function Main'));
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
const packageDir=path.join(prefix,'node_modules','@openai','codex');
fs.mkdirSync(path.join(packageDir,'bin'),{recursive:true});
fs.writeFileSync(path.join(packageDir,'package.json'),JSON.stringify({bin:{codex:'bin/codex.js'}}));
fs.writeFileSync(path.join(packageDir,'bin','codex.js'),'console.log("codex-cli '+fixture.version+'")');
'@,$utf8)
 function NodeRuntime { return @($testNode,$fakeNpm) }
 $testArchive='{"provider":"codex","version":"1.2.3"}'
 function Download($url,$destination,$deadline) { [IO.File]::WriteAllText($destination,$testArchive,$utf8) }
 function Integrity { return 'sha512-'+[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($utf8.GetBytes($testArchive))) }
 $env:PATH=[IO.Path]::GetDirectoryName($testNode)
 $root=Join-Path $homeDirectory '.ssh-approval-cli/codex'
 PrivateDirectory (Join-Path $homeDirectory '.codex')
 $credentialFixture=Join-Path $homeDirectory '.codex/auth-fixture.txt'
 [IO.File]::WriteAllText($credentialFixture,'credential-fixture-unchanged',$utf8)
 $before=Inspect $root 'codex'
 $fixtureStage='install'
 $expiry=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+60000
 $operation='a'*48
 $receipt=Install $root 'install' 'codex' '1.2.3' (Integrity) $before.installationRevision $expiry $operation
 Assert ($receipt.state -eq 'completed') 'fixture-install'
 Assert ((Inspect $root 'codex').version -eq '1.2.3') 'fixture-active'
 Assert ((Status $root 'codex' $operation).state -eq 'completed') 'receipt-read'
 Assert ((Install $root 'install' 'codex' '1.2.3' (Integrity) $before.installationRevision $expiry $operation).state -eq 'completed') 'receipt-no-replay'
 $oldActive=(ReadJson (Join-Path $root 'current.json')).active
 $before=Inspect $root 'codex'
 $fixtureStage='update'
 $testArchive='{"provider":"codex","version":"1.2.4"}'
 $receipt=Install $root 'update' 'codex' '1.2.4' (Integrity) $before.installationRevision $expiry ('b'*48)
 Assert ($receipt.state -eq 'completed' -and (Inspect $root 'codex').version -eq '1.2.4') 'fixture-update'
 Assert (Test-Path -LiteralPath (Join-Path $root $oldActive)) 'previous-version-retained'
 $rejected=$false
 try { $null=Install $root 'update' 'codex' '1.2.4' (Integrity) $before.installationRevision $expiry ('c'*48) } catch { $rejected=$true }
 Assert $rejected 'stale-revision'
 $before=Inspect $root 'codex'
 $testArchive='{"provider":"codex","version":"1.2.5"}'
 $rejected=$false
 try { $null=Install $root 'update' 'codex' '1.2.5' ('sha512-'+[Convert]::ToBase64String((New-Object byte[] 64))) $before.installationRevision $expiry ('f'*48) } catch { $rejected=$true }
 Assert ($rejected -and (Inspect $root 'codex').version -eq '1.2.4') 'integrity-before-activation'
 Assert ((Status $root 'codex' ('f'*48)).state -eq 'failed') 'failure-receipt'
 Assert ([IO.File]::ReadAllText($credentialFixture) -eq 'credential-fixture-unchanged') 'credentials-preserved'
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
 [Console]::Out.WriteLine('ok')
} catch { [Console]::Error.WriteLine('CLI_FIXTURE_STAGE='+$fixtureStage); throw
} finally { if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force} }
`;
}
