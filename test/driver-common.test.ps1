$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/driver-common.ps1"
$taskRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'package.json') -Encoding utf8 | ConvertFrom-Json).version
$expected = Join-Path $taskRoot "dist/ssh-approval-portal-$version.tar.gz"
$defaultContext = $null
$explicitContext = $null
try {
  $defaultContext = New-PackageContext '' '' ''
  if ((Get-FileHash -LiteralPath (Join-Path $defaultContext 'candidate.tar.gz') -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash) { throw 'Default archive does not match the current version' }
  $explicitContext = New-PackageContext $expected '' ''
  if ((Get-FileHash -LiteralPath (Join-Path $explicitContext 'candidate.tar.gz') -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash) { throw 'Explicit archive changed' }
  $missing = Join-Path $taskRoot ('missing-' + [Guid]::NewGuid().ToString('N') + '.tar.gz')
  $refused = $false
  try { New-PackageContext $missing '' '' | Out-Null } catch { $refused = $true }
  if (!$refused) { throw 'Missing archive was accepted' }
  Write-Output 'CURRENT VERSION DEFAULT, EXPLICIT ARCHIVE, MISSING ARCHIVE REFUSAL: PASS'
} finally {
  Remove-PackageContext $defaultContext
  Remove-PackageContext $explicitContext
}
