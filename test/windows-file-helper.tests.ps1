# Execute only on the Windows test runner, elevated. Fixtures are isolated per run.
[CmdletBinding()]
param(
    [string]$PowerShellExe = 'powershell.exe',
    [string]$WorkRoot = (Join-Path ([IO.Path]::GetTempPath()) ('ssh-approval-helper-' + [Guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$passed = 0
$fixtureCreated = $false
$fixturePath = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
$fixtureParent = [IO.Path]::GetDirectoryName($fixturePath)
function Assert-True($condition, [string]$label) {
    if (!$condition) { throw $label }
    $script:passed++
}
function Start-Script([string]$scriptPath, [string]$arguments, [string]$inputText = '') {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $PowerShellExe
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" ' + $arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($inputText)
        $process.StandardInput.Close()
        return @{ process = $process; stdout = $stdout; stderr = $stderr }
    } catch { $process.Dispose(); throw }
}
function Complete-Script($pending) {
    $process = $pending.process
    try {
        if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'helper timeout' }
        $stdout = $pending.stdout
        $stderr = $pending.stderr
        Assert-True ([string]::IsNullOrWhiteSpace($stderr.Result)) 'stderr must not contain exception details'
        $data = ConvertFrom-Json -InputObject $stdout.Result
        return @{ exitCode = $process.ExitCode; data = $data; raw = $stdout.Result }
    } finally { $process.Dispose() }
}
function Invoke-Script([string]$scriptPath, [string]$arguments, [string]$inputText = '') {
    return Complete-Script (Start-Script $scriptPath $arguments $inputText)
}
function Remove-FixtureEntry([IO.FileSystemInfo]$entry) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if (($entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($entry.FullName, $false) }
        else { [IO.File]::Delete($entry.FullName) }
        return
    }
    if ($entry -is [IO.DirectoryInfo]) {
        foreach ($child in $entry.GetFileSystemInfos()) { Remove-FixtureEntry $child }
        [IO.Directory]::Delete($entry.FullName, $false)
    } else { [IO.File]::Delete($entry.FullName) }
}
function Request([string]$action = 'publish', [string]$path = $script:target) {
    return @{ action = $action; id = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N').Substring(0, 16);
        remotePath = $path; maxBytes = 67108864L; overwrite = $false; size = $script:bytes.Length; sha256 = $script:digest }
}
function Call($request) { return Invoke-Script $script:helper '' ($request | ConvertTo-Json -Compress) }
function Refused($request, [string]$code) {
    $result = Call $request
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq $code) ('expected ' + $code)
    Assert-True (!$result.raw.Contains('sensitive-marker')) 'content must never be returned'
}
function Stage($request) { [IO.File]::WriteAllBytes((Join-Path $script:stage ($request.id + '.part')), $script:bytes) }
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if (Test-Path -LiteralPath $WorkRoot) { throw 'fixture path already exists' }
    if ([string]::IsNullOrWhiteSpace($fixtureParent) -or !(Test-Path -LiteralPath $fixtureParent -PathType Container)) { throw 'fixture parent must exist' }
    $null = [IO.Directory]::CreateDirectory($WorkRoot)
    $fixtureCreated = $true
    $install = Join-Path $WorkRoot 'helper'
    $script:stage = Join-Path $WorkRoot 'incoming'
    $root = Join-Path $WorkRoot 'files'
    $script:target = Join-Path $root 'result.bin'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $installer = Join-Path $PSScriptRoot '../scripts/install-windows-helper.ps1'
    $arguments = '-AccountSid "' + $sid + '" -FileRoot "' + $root + '" -InstallRoot "' + $install + '" -StageRoot "' + $script:stage + '"'
    $installed = Invoke-Script $installer $arguments
    Assert-True ($installed.exitCode -eq 0 -and $installed.data.installed) 'new dedicated installation'
    $script:helper = $installed.data.helper
    $reinstall = Invoke-Script $installer $arguments
    Assert-True ($reinstall.exitCode -eq 1 -and $reinstall.data.errorCode -eq 'DESTINATION_EXISTS') 'existing installation must be preserved'
    $script:bytes = [Text.Encoding]::UTF8.GetBytes("sensitive-marker`r`nUnicode: 한글`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $script:digest = [BitConverter]::ToString($sha.ComputeHash($script:bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

    $request = Request
    Stage $request
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published -and $result.data.sha256 -ceq $script:digest -and $result.data.size -eq $script:bytes.Length) 'publish metadata'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:target)) -ceq [Convert]::ToBase64String($script:bytes)) 'binary publish bytes'
    Refused $request 'DESTINATION_EXISTS'
    $request.overwrite = $true
    $acl = (Get-Acl -LiteralPath $script:target).Sddl
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published) 'atomic overwrite'
    Assert-True ((Get-Acl -LiteralPath $script:target).Sddl -ceq $acl) 'overwrite retains destination DACL'
    $request.action = 'cleanup'
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.cleaned) 'cleanup staged data'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part')))) 'cleanup removed only own stage'
    Assert-True ((Call $request).exitCode -eq 0) 'cleanup idempotent'

    $snapshot = Request 'snapshot'
    $result = Call $snapshot
    Assert-True ($result.exitCode -eq 0 -and $result.data.sha256 -ceq $script:digest -and $result.data.size -eq $script:bytes.Length) 'snapshot metadata'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $script:stage ($snapshot.id + '.part')))) -ceq [Convert]::ToBase64String($script:bytes)) 'snapshot binary bytes'
    Refused $snapshot 'DESTINATION_EXISTS'
    $snapshot.id = (Request).id
    $snapshot.maxBytes = 1
    Refused $snapshot 'FILE_TOO_LARGE'

    $changed = Request 'publish' (Join-Path $root 'changed.bin')
    Stage $changed
    $changed.sha256 = '0' * 64
    Refused $changed 'FILE_CHANGED'
    Assert-True (!(Test-Path -LiteralPath $changed.remotePath)) 'hash mismatch cannot publish'
    Assert-True (@(Get-ChildItem -LiteralPath $root -Filter '.ssh-approval-*.part').Count -eq 0) 'failed publish removes temporary file'
    $changed.size++
    Refused $changed 'FILE_CHANGED'
    Refused (Request 'snapshot' (Join-Path $root 'missing.bin')) 'FILE_NOT_FOUND'
    Refused (Request 'publish' (Join-Path $root 'missing-parent/file.bin')) 'PARENT_NOT_FOUND'
    Refused (Request 'snapshot' (Join-Path $WorkRoot 'files-other/file.bin')) 'UNSAFE_PATH'

    $racePath = Join-Path $root 'race.bin'
    $first = Request 'publish' $racePath
    $second = Request 'publish' $racePath
    Stage $first
    Stage $second
    $one = Start-Script $script:helper '' ($first | ConvertTo-Json -Compress)
    $two = Start-Script $script:helper '' ($second | ConvertTo-Json -Compress)
    $results = @((Complete-Script $one), (Complete-Script $two))
    Assert-True (@($results | Where-Object { $_.exitCode -eq 0 -and $_.data.published }).Count -eq 1) 'concurrent new publish has exactly one winner'
    Assert-True (@($results | Where-Object { $_.exitCode -eq 1 -and $_.data.errorCode -ceq 'DESTINATION_EXISTS' }).Count -eq 1) 'concurrent publish loser cannot overwrite'
    $locked = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try { Refused (Request 'snapshot') 'PERMISSION_DENIED' } finally { $locked.Dispose() }

    foreach ($path in @('relative.txt', '\\server\share\file', '\\?\C:\file', 'C:relative', 'C:\file:stream',
        ($root + '\..\escape'), ($root + '\.\file'), ($root + '\a\\b'), ($root + '\NUL.txt'),
        ($root + '\COM1'), ($root + '\name.'), ($root + '\name '), ($root + '\folder\'))) {
        Refused (Request 'snapshot' $path) 'UNSAFE_PATH'
    }
    $invalid = Request
    $invalid.id = '../sensitive-marker'
    Refused $invalid 'INVALID_REQUEST'
    $invalid = Request
    $invalid.overwrite = 'true'
    Refused $invalid 'INVALID_REQUEST'
    $invalid = Request
    $invalid.maxBytes = 1.5
    Refused $invalid 'INVALID_REQUEST'
    $result = Invoke-Script $script:helper '' ('x' * 16385)
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'bounded input'

    $outside = Join-Path $WorkRoot 'outside'
    $null = [IO.Directory]::CreateDirectory($outside)
    [IO.File]::WriteAllBytes((Join-Path $outside 'secret.bin'), $script:bytes)
    $junction = Join-Path $root 'junction'
    $null = New-Item -ItemType Junction -Path $junction -Target $outside
    Refused (Request 'snapshot' (Join-Path $junction 'secret.bin')) 'UNSAFE_PATH'
    $hardlink = Join-Path $root 'hardlink.bin'
    $null = New-Item -ItemType HardLink -Path $hardlink -Target (Join-Path $outside 'secret.bin')
    Refused (Request 'snapshot' $hardlink) 'UNSAFE_PATH'
    $symlink = Join-Path $root 'symlink.bin'
    $null = New-Item -ItemType SymbolicLink -Path $symlink -Target (Join-Path $outside 'secret.bin')
    Refused (Request 'snapshot' $symlink) 'UNSAFE_PATH'
    $badStage = Request 'cleanup'
    $null = New-Item -ItemType SymbolicLink -Path (Join-Path $script:stage ($badStage.id + '.part')) -Target (Join-Path $outside 'secret.bin')
    Refused $badStage 'UNSAFE_PATH'
    Assert-True (Test-Path -LiteralPath (Join-Path $outside 'secret.bin')) 'unsafe cleanup cannot touch target'
    [Console]::Out.WriteLine((@{ passed = $passed } | ConvertTo-Json -Compress))
    exit 0
} catch {
    # Fixture assertion labels contain no request or file bytes.
    [Console]::Error.WriteLine('Windows helper verification failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($fixtureCreated) {
        $resolvedFixture = [IO.Path]::GetFullPath($WorkRoot).TrimEnd('\')
        if (!$resolvedFixture.Equals($fixturePath, [StringComparison]::OrdinalIgnoreCase) -or
            ![IO.Path]::GetDirectoryName($resolvedFixture).Equals($fixtureParent, [StringComparison]::OrdinalIgnoreCase) -or
            $resolvedFixture.Equals([IO.Path]::GetPathRoot($resolvedFixture).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture cleanup boundary mismatch' }
        Remove-FixtureEntry ([IO.DirectoryInfo]::new($resolvedFixture))
    }
}
