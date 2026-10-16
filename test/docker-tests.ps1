param(
  [string[]]$Versions = @('22.04','24.04'),
  [ValidateSet('amd64','arm64')][string]$Architecture = 'amd64',
  [string]$TaskTag = ('solid-' + [Guid]::NewGuid().ToString('N').Substring(0,10)),
  [string]$CandidateArchive = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/ssh-approval-portal-1.0.0.tar.gz'),
  [string]$BaselineArchive = '',
  [string]$BaselineSha256 = '',
  [string]$ImagePrefix = 'ssh-portal-test',
  [string]$EvidenceDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'ssh-approval-portal-evidence')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/driver-common.ps1"
Assert-TaskTag $TaskTag
$context = $null
$results = @()
try {
  $context = New-PackageContext $CandidateArchive $BaselineArchive $BaselineSha256
  foreach ($version in $Versions) {
    if ($version -notin @('22.04','24.04')) { throw 'Unsupported fixture Ubuntu version' }
    $tag = $ImagePrefix + ':' + $TaskTag + '-' + $version.Replace('.','') + '-' + $Architecture
    $container = 'ssh-portal-proof-' + $TaskTag + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    try {
      $hasBaseline = if ($BaselineArchive) { '1' } else { '0' }
      Assert-TaskImageTarget $tag $TaskTag
      docker build --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --build-arg "UBUNTU_VERSION=$version" --build-arg "HAS_BASELINE=$hasBaseline" -f "$PSScriptRoot/Dockerfile" -t $tag $context
      if ($LASTEXITCODE -ne 0) { throw 'Image build failed' }
      docker run -d --platform "linux/$Architecture" --label "io.ssh-approval.solid-task=$TaskTag" --privileged --tmpfs /run --tmpfs /run/lock --name $container $tag
      if ($LASTEXITCODE -ne 0) { throw 'Test container failed' }
      docker exec $container bash /source/test/container-test.sh
      if ($LASTEXITCODE -ne 0) {
        docker exec $container journalctl -u ssh.service -u ssh-approval-bridge.service -n 30 --no-pager
        throw "Ubuntu $version test failed"
      }
      $manifestHash = (docker exec $container sha256sum /source/release-manifest.json).Split(' ')[0]
      if ($LASTEXITCODE -ne 0) { throw 'Cannot read tested manifest hash' }
      $results += @{ubuntu=$version; architecture=$Architecture; execution=$(if ($Architecture -eq 'arm64') {'emulated'} else {'native'}); manifestSha256=$manifestHash; image=$tag; baselineUpgrade=[bool]$BaselineArchive; taskTag=$TaskTag; result='PASS'}
    } finally {
      docker rm -f $container 2>$null | Out-Null
    }
  }
  Write-DriverEvidence $EvidenceDir ("docker-$TaskTag-$Architecture-results.json") $results
} finally {
  Remove-PackageContext $context
}
