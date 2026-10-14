param([ValidateSet('amd64','arm64')][string]$Architecture = 'amd64')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,10)
$target = 'ssh-compose-target-' + $suffix
$driver = 'ssh-compose-driver-' + $suffix
$project = 'ssh-compose-proof-' + $suffix
$state = 'ssh-compose-state-' + $suffix
$secret = 'ssh-compose-secret-' + $suffix
$image = 'ssh-approval-portal:0.3.0-' + $Architecture
try {
  docker build -f "$taskRoot/test/compose-driver.Dockerfile" -t ssh-compose-test-driver $taskRoot
  if ($LASTEXITCODE -ne 0) { throw 'Compose driver build failed' }
  docker volume create $state | Out-Null
  docker volume create $secret | Out-Null
  $secretMount = (docker volume inspect $secret --format '{{.Mountpoint}}').Trim()
  docker run -d --platform "linux/$Architecture" --privileged --tmpfs /run --tmpfs /run/lock --name $target --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=/etc/ssh-approval-portal" "ssh-portal-test-2404-$Architecture"
  if ($LASTEXITCODE -ne 0) { throw 'Compose SSH fixture failed' }
  docker exec $target bash /source/scripts/prepare-docker.sh --admin-origin https://example.test --grant-sudo-all
  if ($LASTEXITCODE -ne 0) { throw 'Compose host preparation failed' }
  docker exec $target sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-approval-portal/docker-secrets.env
  $uid = (docker exec $target id -u mcpbridge).Trim()
  $gid = (docker exec $target id -g mcpbridge).Trim()
  docker run --name $driver --env "TEST_PROJECT=$project" --env "TEST_TARGET=$target" --env "TEST_STATE=$state" --env "TEST_SECRET_SOURCE=$secretMount" --env "TEST_UID=$uid" --env "TEST_GID=$gid" --env "TEST_IMAGE=$image" --mount type=bind,src=/var/run/docker.sock,target=/var/run/docker.sock --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=$secretMount,readonly" ssh-compose-test-driver
  if ($LASTEXITCODE -ne 0) { throw 'Compose integration failed' }
} finally {
  docker rm -f $driver $target 2>$null | Out-Null
  docker volume rm $state $secret 2>$null | Out-Null
}
