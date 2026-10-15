param(
  [ValidateSet('amd64','arm64')][string]$Architecture = 'amd64',
  [string]$TaskTag = ('solid-' + [Guid]::NewGuid().ToString('N').Substring(0,10)),
  [string]$CandidateArchive = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/ssh-approval-portal-0.3.0.tar.gz'),
  [string]$RuntimeImage = '',
  [string]$BaselineImage = '',
  [string]$FixtureImage = '',
  [string]$DriverImage = '',
  [string]$EvidenceDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'ssh-approval-portal-evidence')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/driver-common.ps1"
Assert-TaskTag $TaskTag
$taskRoot = Split-Path -Parent $PSScriptRoot
$suffix = $TaskTag + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$target = 'ssh-compose-target-' + $suffix
$driver = 'ssh-compose-driver-' + $suffix
$project = 'ssh-compose-proof-' + $suffix
$state = 'ssh-compose-state-' + $suffix
$secret = 'ssh-compose-secret-' + $suffix
if (!$RuntimeImage) { $RuntimeImage = "ssh-approval-portal:$TaskTag-$Architecture" }
if (!$FixtureImage) { $FixtureImage = "ssh-portal-test:$TaskTag-2404-$Architecture" }
if (!$DriverImage) { $DriverImage = "ssh-compose-test-driver:$TaskTag" }
$context = $null
try {
  $context = New-PackageContext $CandidateArchive '' ''
  Assert-TaskImageTarget $DriverImage $TaskTag
  docker build --label "io.ssh-approval.solid-task=$TaskTag" -f "$taskRoot/test/compose-driver.Dockerfile" -t $DriverImage $context
  if ($LASTEXITCODE -ne 0) { throw 'Compose driver build failed' }
  docker volume create --label "io.ssh-approval.solid-task=$TaskTag" $state | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'State volume creation failed' }
  docker volume create --label "io.ssh-approval.solid-task=$TaskTag" $secret | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Secret volume creation failed' }
  $secretMount = (docker volume inspect $secret --format '{{.Mountpoint}}').Trim()
  docker run -d --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --privileged --tmpfs /run --tmpfs /run/lock --name $target --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=/etc/ssh-approval-portal" $FixtureImage
  if ($LASTEXITCODE -ne 0) { throw 'Compose SSH fixture failed' }
  docker exec $target bash /source/scripts/prepare-docker.sh --admin-origin https://example.test --grant-sudo-all
  if ($LASTEXITCODE -ne 0) { throw 'Compose host preparation failed' }
  docker exec $target sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-approval-portal/docker-secrets.env
  $uid = (docker exec $target id -u mcpbridge).Trim()
  $gid = (docker exec $target id -g mcpbridge).Trim()
  docker run --label "io.ssh-approval.solid-task=$TaskTag" --name $driver --env "TEST_TASK_TAG=$TaskTag" --env "TEST_PROJECT=$project" --env "TEST_TARGET=$target" --env "TEST_STATE=$state" --env "TEST_SECRET_SOURCE=$secretMount" --env "TEST_UID=$uid" --env "TEST_GID=$gid" --env "TEST_IMAGE=$RuntimeImage" --env "TEST_BASELINE_IMAGE=$BaselineImage" --mount type=bind,src=/var/run/docker.sock,target=/var/run/docker.sock --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=$secretMount,readonly" $DriverImage
  if ($LASTEXITCODE -ne 0) { throw 'Compose integration failed' }
  Write-DriverEvidence $EvidenceDir "compose-$TaskTag-$Architecture-results.json" @{architecture=$Architecture; image=$RuntimeImage; baselineImage=$BaselineImage; baselineUpgrade=[bool]$BaselineImage; taskTag=$TaskTag; result='PASS'; scope='actual-compose/update/rollback/custom-ports/secret-preservation/SSH/failed-start'}
} finally {
  docker rm -f $driver $target 2>$null | Out-Null
  docker volume rm $state $secret 2>$null | Out-Null
  Remove-PackageContext $context
}
