param(
  [ValidateSet('amd64','arm64')][string]$Architecture = 'amd64',
  [string]$TaskTag = 'vault-local-20261019-v1',
  [Parameter(Mandatory=$true)][string]$CandidateArchive,
  [Parameter(Mandatory=$true)][string]$BaselineArchive,
  [Parameter(Mandatory=$true)][string]$BaselineSha256,
  [ValidateSet('INITIAL_VAULT_ASSESSMENT','VAULT_FIXTURE_FAILURE:UNTRUSTED_CA_REJECTED')][string]$BaselineFailureWitness = 'INITIAL_VAULT_ASSESSMENT',
  [Parameter(Mandatory=$true)][string]$EvidenceDir
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. "$PSScriptRoot/driver-common.ps1"
Assert-TaskTag $TaskTag
$taskRoot = Split-Path -Parent $PSScriptRoot
$name = "ssh-$TaskTag-$Architecture"
$image = "ssh-vault-test:$TaskTag-$Architecture"
$context = $null
$created = $false
function Save-Text([string]$Name, [string]$Value) {
  [System.IO.File]::WriteAllText((Join-Path $EvidenceDir $Name), $Value, [System.Text.UTF8Encoding]::new($false))
}
function Invoke-Probe([string]$Phase) {
  $started = [DateTime]::UtcNow.ToString('o')
  $info=[System.Diagnostics.ProcessStartInfo]::new('docker')
  $info.UseShellExecute=$false; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
  foreach($arg in @('exec',$name,'node','/candidate/test/vault-integration.mjs')){ $info.ArgumentList.Add($arg) }
  $process=[System.Diagnostics.Process]::new();$process.StartInfo=$info
  try {
    if(!$process.Start()){throw 'Probe process did not start'}
    $stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(240000)){ $process.Kill($true); throw 'Vault probe exceeded its total 240 second bound' }
    $code=$process.ExitCode;$stdout=$stdoutTask.GetAwaiter().GetResult();$stderr=$stderrTask.GetAwaiter().GetResult()
  } finally { $process.Dispose() }
  $text=($stdout+$stderr).TrimEnd()
  Save-Text "$Architecture-$Phase.stdout.log" $stdout
  Save-Text "$Architecture-$Phase.stderr.log" $stderr
  Save-Text "$Architecture-$Phase.log" ($text + "`n")
  Write-DriverEvidence $EvidenceDir "$Architecture-$Phase-run.json" @{argv=@('docker','exec',$name,'node','/candidate/test/vault-integration.mjs');startedAt=$started;finishedAt=[DateTime]::UtcNow.ToString('o');exitCode=$code;signal=$null;timeoutMs=240000;phase=$Phase;architecture=$Architecture}
  if ($Phase -eq 'red') {
    if ($code -ne 1 -or ($text.Trim() -split "`n")[-1].Trim() -ne $BaselineFailureWitness) { throw 'Baseline failed outside the required public assessment assertion' }
    if ($BaselineFailureWitness -ne 'INITIAL_VAULT_ASSESSMENT' -and $text -notmatch '"stage":"initial","status":"PASS"') { throw 'TLS sensitivity baseline did not pass the initial Vault assessment' }
  } elseif ($code -ne 0) { throw 'Actual Vault integration failed; inspect the fixed public stage only' }
}
try {
  New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
  $existing = docker container inspect $name --format '{{.Id}}' 2>$null
  if ($LASTEXITCODE -eq 0) { throw 'Task container name already exists; inspect it instead of restarting' }
  Assert-TaskImageTarget $image $TaskTag
  $context = New-PackageContext $CandidateArchive $BaselineArchive $BaselineSha256
  $build = @(docker build --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" -f "$taskRoot/test/vault-container.Dockerfile" -t $image $context 2>&1)
  $code=$LASTEXITCODE
  Save-Text "$Architecture-build.log" (($build | ForEach-Object {$_.ToString()}) -join "`n")
  if ($code -ne 0) { throw 'Vault fixture image build failed' }
  docker run -d --name $name --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=384m $image | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Restricted Vault fixture did not start' }
  $created=$true
  $observed=(docker inspect $name | ConvertFrom-Json)[0]
  if ($observed.Config.User -ne '1000:1000' -or !$observed.HostConfig.ReadonlyRootfs -or $observed.HostConfig.Privileged -or $observed.HostConfig.NetworkMode -ne 'none' -or $observed.HostConfig.PidsLimit -ne 128 -or 'ALL' -notin $observed.HostConfig.CapDrop -or 'no-new-privileges' -notin $observed.HostConfig.SecurityOpt -or $observed.Mounts.Count -ne 0 -or $observed.HostConfig.Tmpfs.'/tmp' -notmatch 'noexec') { throw 'Fixture isolation differs from the required controls' }
  Write-DriverEvidence $EvidenceDir "$Architecture-isolation.json" @{containerId=$observed.Id;image=$observed.Image;user=$observed.Config.User;network=$observed.HostConfig.NetworkMode;readOnly=$observed.HostConfig.ReadonlyRootfs;capDrop=$observed.HostConfig.CapDrop;securityOpt=$observed.HostConfig.SecurityOpt;pids=$observed.HostConfig.PidsLimit;tmpfs=$observed.HostConfig.Tmpfs;mounts=$observed.Mounts}
  docker exec $name ln -s /baseline /tmp/vault-source
  if ($LASTEXITCODE -ne 0) { throw 'Baseline source binding failed' }
  Invoke-Probe 'red'
  docker exec $name rm /tmp/vault-source
  if ($LASTEXITCODE -ne 0) { throw 'Task-owned source link replacement failed' }
  docker exec $name ln -s /candidate /tmp/vault-source
  if ($LASTEXITCODE -ne 0) { throw 'Candidate source binding failed' }
  Invoke-Probe 'green'
  $tests=@(docker exec $name node --test --test-concurrency=1 'test/*.test.mjs' 2>&1)
  $code=$LASTEXITCODE;Save-Text "$Architecture-node.log" (($tests | ForEach-Object {$_.ToString()}) -join "`n")
  if ($code -ne 0) { throw 'Node regression suite failed' }
  $python=@(docker exec --env PYTHONDONTWRITEBYTECODE=1 $name python3 -B -m unittest discover -s test -p test_settings_contract.py 2>&1)
  $code=$LASTEXITCODE;Save-Text "$Architecture-python.log" (($python | ForEach-Object {$_.ToString()}) -join "`n")
  if ($code -ne 0) { throw 'Python settings contract suite failed' }
  Write-DriverEvidence $EvidenceDir "$Architecture-results.json" @{status='PASS';architecture=$Architecture;candidateSha256=(Get-FileHash -LiteralPath $CandidateArchive -Algorithm SHA256).Hash.ToLowerInvariant();baselineSha256=$BaselineSha256;imageId=$observed.Image;scope='actual TLS Vault restricted ACL / lifecycle and restarts / public MCP red-green / malformed peers / Node regressions / Python configuration'}
} finally {
  if ($created) {
    $owner=docker inspect $name --format '{{index .Config.Labels "io.ssh-approval.solid-task"}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and ($owner -join '').Trim() -eq $TaskTag) { docker rm -f $name | Out-Null }
  }
  Remove-PackageContext $context
}
