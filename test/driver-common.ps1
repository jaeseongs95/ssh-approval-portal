function Assert-TaskTag([string]$TaskTag) {
  if ($TaskTag -notmatch '^[a-z0-9][a-z0-9-]{0,40}$') { throw 'Use a short lowercase task tag' }
}

function Assert-TaskImageTarget([string]$Image, [string]$TaskTag) {
  $owner = docker image inspect $Image --format '{{ index .Config.Labels "io.ssh-approval.solid-task" }}' 2>$null
  if ($LASTEXITCODE -eq 0 -and ($owner -join '').Trim() -ne $TaskTag) { throw 'Refusing to overwrite an image outside this test task' }
}

function New-PackageContext([string]$CandidateArchive, [string]$BaselineArchive, [string]$BaselineSha256) {
  $candidate = (Resolve-Path -LiteralPath $CandidateArchive).Path
  if ($BaselineArchive) {
    $baseline = (Resolve-Path -LiteralPath $BaselineArchive).Path
    if (!$BaselineSha256 -or (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash -ne $BaselineSha256) { throw 'Baseline archive digest mismatch or expected digest missing' }
  }
  $context = Join-Path ([System.IO.Path]::GetTempPath()) ('ssh-portal-fixture-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $context | Out-Null
  Copy-Item -LiteralPath $candidate -Destination (Join-Path $context 'candidate.tar.gz')
  if ($BaselineArchive) {
    Copy-Item -LiteralPath $baseline -Destination (Join-Path $context 'baseline.tar.gz')
  } else {
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $context 'baseline.tar.gz')
  }
  return $context
}

function Remove-PackageContext([string]$Context) {
  if (!$Context -or !(Test-Path -LiteralPath $Context)) { return }
  $resolved = (Resolve-Path -LiteralPath $Context).Path
  $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (!$resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notmatch '^ssh-portal-fixture-[0-9a-f]{32}$') { throw 'Unsafe fixture context cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Write-DriverEvidence([string]$EvidenceDir, [string]$Name, $Value) {
  New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $EvidenceDir $Name), ($Value | ConvertTo-Json -Depth 8) + "`n", [System.Text.UTF8Encoding]::new($false))
}
