#requires -Version 7.0
param(
  [string]$TaskTag = ('jev-linux-' + [Guid]::NewGuid().ToString('N').Substring(0,10)),
  [Parameter(Mandatory=$true)][string]$EvidenceDir
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/driver-common.ps1"
Assert-TaskTag $TaskTag
$taskRoot = Split-Path -Parent $PSScriptRoot
$image = "ssh-jev-linux:$TaskTag"
$container = "ssh-jev-linux-$TaskTag"
$baseImage = 'ssh-approval-portal:docker-local-20261019-v5-amd64'
$expectedBase = 'sha256:721fa3d77bde326ce1c9ea1363b44d463de8f519bad67495be9e0b47827845a6'
$base = (docker image inspect $baseImage --format '{{.Id}}').Trim()
if ($LASTEXITCODE -ne 0 -or $base -ne $expectedBase) { throw 'Pinned local fixture base image changed' }
if (Test-Path -LiteralPath $EvidenceDir) { throw 'Use a new evidence directory; preserve earlier execution results' }
New-Item -ItemType Directory -Path $EvidenceDir | Out-Null
$evidenceRoot = (Resolve-Path -LiteralPath $EvidenceDir).Path
$context = Join-Path $evidenceRoot 'context'
$source = Join-Path $context 'source'
New-Item -ItemType Directory -Path $source | Out-Null
$tracked = ((git -C $taskRoot ls-files -z) -join "`n") -split "`0"
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate tracked source' }
$paths = @($tracked + @('test/source-linux-runtime.mjs','test/source-linux.Dockerfile','test/source-linux.ps1','web/dist/app.js','ui/dist/card.html') | Where-Object { $_ } | Sort-Object -Unique)
$inputFiles = @()
foreach ($path in $paths) {
  if ($path -match '(^|/)(\.\.?)(/|$)' -or [IO.Path]::IsPathRooted($path)) { throw 'Unsafe source path' }
  $from = Join-Path $taskRoot $path
  if ((Get-Item -LiteralPath $from).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source symlink/junction refused' }
  $to = Join-Path $source $path
  [IO.Directory]::CreateDirectory((Split-Path -Parent $to)) | Out-Null
  Copy-Item -LiteralPath $from -Destination $to
  $inputFiles += @{path=$path;sha256=(Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash.ToLower()}
}
[IO.File]::WriteAllText((Join-Path $evidenceRoot 'source-inputs.json'), ($inputFiles | ConvertTo-Json -Depth 4) + "`n", [Text.UTF8Encoding]::new($false))
$existingImage = docker image ls --filter "reference=$image" --format '{{.Repository}}:{{.Tag}}'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect planned fixture image name' }
if (($existingImage -join '').Trim()) { Assert-TaskImageTarget $image $TaskTag }
$runCode = $null
try {
  docker build --label "io.ssh-approval.solid-task=$TaskTag" -f (Join-Path $source 'test/source-linux.Dockerfile') -t $image $context
  if ($LASTEXITCODE -ne 0) { throw 'Source Linux fixture image build failed' }
  $imageId = (docker image inspect $image --format '{{.Id}}').Trim()
  docker run --name $container --label "io.ssh-approval.solid-task=$TaskTag" --hostname source-linux-fixture --add-host source-linux-fixture:127.0.0.1 --network none --read-only --memory 768m --cpus 2 --pids-limit 256 --cap-drop NET_RAW --tmpfs /tmp:rw,nosuid,size=128m,mode=1777 --tmpfs /run:rw,nosuid,size=64m,mode=755 --env TZ=UTC $image
  $runCode = $LASTEXITCODE
  $inspection = docker inspect $container | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect own fixture container' }
  $c = $inspection[0]
  $hostPorts = if ($null -eq $c.HostConfig.PortBindings) {0} else {@($c.HostConfig.PortBindings.PSObject.Properties).Count}
  $isolation = @{privileged=$c.HostConfig.Privileged;networkMode=$c.HostConfig.NetworkMode;readOnlyRoot=$c.HostConfig.ReadonlyRootfs;memory=$c.HostConfig.Memory;pidsLimit=$c.HostConfig.PidsLimit;hostBindings=@($c.Mounts | Where-Object Type -eq 'bind').Count;hostPorts=$hostPorts;taskLabel=$c.Config.Labels.'io.ssh-approval.solid-task'}
  if ($isolation.privileged -or $isolation.networkMode -ne 'none' -or !$isolation.readOnlyRoot -or $isolation.hostBindings -ne 0 -or $isolation.hostPorts -ne 0 -or $isolation.taskLabel -ne $TaskTag) { throw 'Fixture isolation differs from plan' }
  Write-DriverEvidence $evidenceRoot 'runtime-result.json' @{status=$(if ($runCode -eq 0) {'PASS'} else {'FAIL'});exitCode=$runCode;taskTag=$TaskTag;container=$container;image=$image;imageId=$imageId;baseImageId=$base;isolation=$isolation;actualJevCalls=0;liveServerChanged=$false}
  if ($runCode -ne 0) { throw 'Actual Linux/OpenSSH source integration failed; inspect preserved raw output' }
} finally {
  $existing = docker ps -a --filter "name=^/$container`$" --format '{{.Names}}'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect own fixture cleanup state' }
  if (($existing -join '').Trim() -eq $container) {
    $owner = docker inspect $container --format '{{ index .Config.Labels "io.ssh-approval.solid-task" }}'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot verify fixture cleanup ownership' }
    if (($owner -join '').Trim() -ne $TaskTag) { throw 'Refusing to remove a container outside this task' }
    docker rm -f $container | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Own fixture container cleanup failed' }
    Write-DriverEvidence $evidenceRoot 'cleanup.json' @{status='PASS';containerRemoved=$container;sourceContextRetained=$context;imageRetained=$image;globalPrune=$false}
  }
}
