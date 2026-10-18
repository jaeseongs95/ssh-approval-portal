param(
  [ValidateSet('amd64','arm64')][string]$Architecture = 'amd64',
  [string]$TaskTag = ('solid-' + [Guid]::NewGuid().ToString('N').Substring(0,10)),
  [string]$CandidateArchive = '',
  [string]$RuntimeImage = '',
  [string]$FixtureImage = '',
  [string]$EvidenceDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'ssh-approval-portal-evidence')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/driver-common.ps1"
Assert-TaskTag $TaskTag
$taskRoot = Split-Path -Parent $PSScriptRoot
$suffix = $TaskTag + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$target = 'ssh-portal-target-' + $suffix
$bridge = 'ssh-portal-runtime-' + $suffix
$state = 'ssh-portal-state-' + $suffix
$secret = 'ssh-portal-secret-' + $suffix
if (!$RuntimeImage) { $RuntimeImage = "ssh-approval-portal:$TaskTag-$Architecture" }
if (!$FixtureImage) { $FixtureImage = "ssh-portal-test:$TaskTag-2404-$Architecture" }
$context = $null
function Wait-RuntimeHealth {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $status = (docker inspect $bridge --format '{{.State.Health.Status}}').Trim()
    if ($LASTEXITCODE -eq 0 -and $status -eq 'healthy') { return }
    Start-Sleep -Seconds 1
  }
  docker logs $bridge
  throw 'Runtime did not become healthy within 60 seconds'
}
try {
  $context = New-PackageContext $CandidateArchive '' ''
  Assert-TaskImageTarget $RuntimeImage $TaskTag
  docker build --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --build-arg PACKAGE_ARCHIVE=candidate.tar.gz -f "$taskRoot/docker/Dockerfile" -t $RuntimeImage $context
  if ($LASTEXITCODE -ne 0) { throw 'Runtime image build failed' }
  docker volume create --label "io.ssh-approval.solid-task=$TaskTag" $state | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'State volume creation failed' }
  docker volume create --label "io.ssh-approval.solid-task=$TaskTag" $secret | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Secret volume creation failed' }
  docker run -d --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --privileged --tmpfs /run --tmpfs /run/lock --name $target --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=/etc/ssh-approval-portal" $FixtureImage
  if ($LASTEXITCODE -ne 0) { throw 'SSH fixture failed' }
  docker exec $target bash /source/scripts/prepare-docker.sh --admin-origin https://example.test --grant-sudo-all
  if ($LASTEXITCODE -ne 0) { throw 'Docker host preparation failed' }
  docker exec $target python3 /source/scripts/compose-env.py /etc/ssh-approval-portal/compose.env 12345 12345
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic Compose settings preparation failed' }
  docker exec $target bash /source/test/compose-env-fixture.sh "$RuntimeImage"
  if ($LASTEXITCODE -ne 0) { throw 'Docker host preparation did not preserve Compose configuration' }
  docker exec $target python3 /source/test/delivery-fixture.py docker-settings /etc/ssh-approval-portal/docker-secrets.env
  if ($LASTEXITCODE -ne 0) { throw 'Custom port fixture failed' }
  docker exec $target sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-approval-portal/docker-secrets.env
  $uid = (docker exec $target id -u mcpbridge).Trim()
  $gid = (docker exec $target id -g mcpbridge).Trim()
  docker run -d --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --name $bridge --network "container:$target" --user "${uid}:$gid" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --tmpfs /tmp:rw,noexec,nosuid,size=16m --env BRIDGE_SECRET_ENV_FILE=/run/secrets/docker-secrets.env --env BRIDGE_TEST_ENV_FILE=/run/secrets/docker-secrets.env --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.ssh,volume-subpath=.ssh,readonly" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.config/ssh-mcp,volume-subpath=.config/ssh-mcp,readonly" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.local/share/ssh-mcp,volume-subpath=.local/share/ssh-mcp" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/transfers,volume-subpath=transfers" --mount "type=volume,src=$secret,target=/run/secrets,readonly" $RuntimeImage
  if ($LASTEXITCODE -ne 0) { throw 'Restricted runtime did not start' }
  Wait-RuntimeHealth
  docker exec $bridge node test/delivery-runtime.mjs --node-license
  if ($LASTEXITCODE -ne 0) { throw 'Runtime health/license verification failed' }
  $before = @(docker exec $target sha256sum /var/lib/ssh-mcp/.config/ssh-mcp/config.toml /etc/ssh-approval-portal/docker-secrets.env /usr/local/libexec/ssh-approval-file-helper)
  docker exec $target bash /source/scripts/install.sh
  if ($LASTEXITCODE -eq 0) { throw 'Native installer accepted a running container bridge' }
  $after = @(docker exec $target sha256sum /var/lib/ssh-mcp/.config/ssh-mcp/config.toml /etc/ssh-approval-portal/docker-secrets.env /usr/local/libexec/ssh-approval-file-helper)
  if (($before -join "`n") -ne ($after -join "`n")) { throw 'Rejected migration mutated shared files' }
  docker exec $bridge node test/ssh-roundtrip.mjs
  if ($LASTEXITCODE -ne 0) { docker logs $bridge; throw 'Runtime SSH roundtrip failed' }
  docker exec $bridge node scripts/maintenance.mjs reserve
  if ($LASTEXITCODE -ne 0) { throw 'Runtime maintenance failed' }
  docker restart $bridge | Out-Null
  Wait-RuntimeHealth
  docker exec $bridge node test/delivery-runtime.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Runtime restart failed' }
  $digest = (docker image inspect $RuntimeImage --format '{{.Id}}').Trim()
  Write-DriverEvidence $EvidenceDir "runtime-$TaskTag-$Architecture-results.json" @{architecture=$Architecture; imageId=$digest; image=$RuntimeImage; taskTag=$TaskTag; result='PASS'; scope='non-root/read-only/cap-drop/noexec/secret-file/custom-ports/actual-SSH/64MiB/restart/prepare-preservation'}
} finally {
  docker rm -f $bridge $target 2>$null | Out-Null
  docker volume rm $state $secret 2>$null | Out-Null
  Remove-PackageContext $context
}
