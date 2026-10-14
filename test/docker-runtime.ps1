param([ValidateSet('amd64','arm64')][string]$Architecture = 'amd64')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,10)
$target = 'ssh-portal-target-' + $suffix
$bridge = 'ssh-portal-runtime-' + $suffix
$state = 'ssh-portal-state-' + $suffix
$secret = 'ssh-portal-secret-' + $suffix
$image = 'ssh-approval-portal:0.3.0-' + $Architecture
$fixture = 'ssh-portal-test-2404-' + $Architecture
function Wait-RuntimeHealth {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $status = (docker inspect $bridge --format '{{.State.Health.Status}}').Trim()
    if ($status -eq 'healthy') { return }
    Start-Sleep -Seconds 1
  }
  docker logs $bridge
  throw 'Runtime did not become healthy within 60 seconds'
}
try {
  docker build --platform "linux/$Architecture" -f "$taskRoot/docker/Dockerfile" -t $image $taskRoot
  if ($LASTEXITCODE -ne 0) { throw 'Runtime image build failed' }
  docker volume create $state | Out-Null
  docker volume create $secret | Out-Null
  docker run -d --platform "linux/$Architecture" --privileged --tmpfs /run --tmpfs /run/lock --name $target --mount "type=volume,src=$state,target=/var/lib/ssh-mcp" --mount "type=volume,src=$secret,target=/etc/ssh-approval-portal" $fixture
  if ($LASTEXITCODE -ne 0) { throw 'SSH fixture failed' }
  docker exec $target bash /source/scripts/prepare-docker.sh --admin-origin https://example.test --grant-sudo-all
  if ($LASTEXITCODE -ne 0) { throw 'Docker host preparation failed' }
  docker exec $target bash /source/scripts/prepare-docker.sh
  if ($LASTEXITCODE -ne 0) { throw 'Docker host preparation was not idempotent' }
  docker exec $target sed -i 's/^BRIDGE_UI_ENABLED=false$/BRIDGE_UI_ENABLED=true/' /etc/ssh-approval-portal/docker-secrets.env
  $uid = (docker exec $target id -u mcpbridge).Trim()
  $gid = (docker exec $target id -g mcpbridge).Trim()
  docker run -d --platform "linux/$Architecture" --name $bridge --network "container:$target" --user "${uid}:$gid" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --tmpfs /tmp --env BRIDGE_SECRET_ENV_FILE=/run/secrets/docker-secrets.env --env BRIDGE_TEST_ENV_FILE=/run/secrets/docker-secrets.env --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.ssh,volume-subpath=.ssh,readonly" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.config/ssh-mcp,volume-subpath=.config/ssh-mcp,readonly" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/.local/share/ssh-mcp,volume-subpath=.local/share/ssh-mcp" --mount "type=volume,src=$state,target=/var/lib/ssh-mcp/transfers,volume-subpath=transfers" --mount "type=volume,src=$secret,target=/run/secrets,readonly" $image
  if ($LASTEXITCODE -ne 0) { throw 'Restricted runtime did not start' }
  Wait-RuntimeHealth
  docker exec $bridge node -e "if(require('fs').statSync('/usr/share/licenses/node/LICENSE').size<1000)process.exit(1)"
  if ($LASTEXITCODE -ne 0) { throw 'Node runtime license is missing' }
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
  docker exec $bridge node -e "fetch('http://127.0.0.1:39124/health').then(r=>r.json()).then(x=>{if(x.maintenance)process.exit(1)}).catch(()=>process.exit(1))"
  if ($LASTEXITCODE -ne 0) { throw 'Runtime restart failed' }
  $digest = (docker image inspect $image --format '{{.Id}}').Trim()
  $evidenceDir = Join-Path (Split-Path -Parent $taskRoot) 'ssh-approval-portal-evidence'
  [System.IO.File]::WriteAllText((Join-Path $evidenceDir "runtime-$Architecture-results.json"), (@{architecture=$Architecture; imageId=$digest; result='PASS'; scope='non-root/read-only/cap-drop/secret-file/actual-SSH/64MiB/restart'} | ConvertTo-Json) + "`n", [System.Text.UTF8Encoding]::new($false))
} finally {
  docker rm -f $bridge $target 2>$null | Out-Null
  docker volume rm $state $secret 2>$null | Out-Null
}
