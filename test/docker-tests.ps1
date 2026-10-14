param([string[]]$Versions = @('22.04','24.04'), [ValidateSet('amd64','arm64')][string]$Architecture = 'amd64')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$results = @()
foreach ($version in $Versions) {
  $tag = 'ssh-portal-test-' + $version.Replace('.','') + '-' + $Architecture
  $container = 'ssh-portal-proof-' + [Guid]::NewGuid().ToString('N').Substring(0,10)
  try {
    docker build --platform "linux/$Architecture" --build-arg "UBUNTU_VERSION=$version" -f "$PSScriptRoot/Dockerfile" -t $tag $taskRoot
    if ($LASTEXITCODE -ne 0) { throw 'Image build failed' }
    docker run -d --platform "linux/$Architecture" --privileged --tmpfs /run --tmpfs /run/lock --name $container $tag
    if ($LASTEXITCODE -ne 0) { throw 'Test container failed' }
    docker exec $container bash /source/test/container-test.sh
    if ($LASTEXITCODE -ne 0) {
      docker exec $container journalctl -u ssh.service -u ssh-approval-bridge.service -n 30 --no-pager
      throw "Ubuntu $version test failed"
    }
    $manifestHash = (docker exec $container sha256sum /source/release-manifest.json).Split(' ')[0]
    $results += @{ubuntu=$version; architecture=$Architecture; execution=$(if ($Architecture -eq 'arm64') {'emulated'} else {'native'}); manifestSha256=$manifestHash; result='PASS'}
  } finally {
    docker rm -f $container 2>$null | Out-Null
  }
}
$evidenceDir = Join-Path (Split-Path -Parent $taskRoot) 'ssh-approval-portal-evidence'
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $evidenceDir ('docker-' + $Architecture + '-results.json')), ($results | ConvertTo-Json -Depth 5) + "`n", [System.Text.UTF8Encoding]::new($false))
