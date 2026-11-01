# Execute only on the Windows test runner, elevated. Fixtures are isolated per run.
[CmdletBinding()]
param(
    [string]$PowerShellExe = 'powershell.exe',
    [string]$WorkRoot = (Join-Path 'C:/ProgramData' ('ssh-approval-helper-' + [Guid]::NewGuid().ToString('N')))
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
function Describe-Result($result) {
    # Whitelist-only failure metadata; never emit the helper response, path or exception text.
    $code = 'unclassified'
    if ($result.data.errorCode -cin @('PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS',
        'UNSAFE_PATH', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED')) { $code = $result.data.errorCode }
    $step = 'none'
    if ($result.data.nativeStep -cin @('native', 'create_directory', 'inspect', 'open', 'filesystem', 'final_path', 'read_security',
        'remove', 'rename_replace', 'rename_new', 'write_security', 'write_times', 'verify_security', 'verify_times', 'read_label', 'write_label', 'verify_label')) { $step = $result.data.nativeStep }
    $number = 0
    if ($result.data.nativeError -is [int] -and $result.data.nativeError -gt 0) { $number = $result.data.nativeError }
    return ('exit=' + [int]$result.exitCode + '; code=' + $code + '; step=' + $step + '; native=' + $number)
}
function Refused($request, [string]$code) {
    $result = Call $request
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq $code) ('expected ' + $code + '; ' + (Describe-Result $result))
    Assert-True (!$result.raw.Contains('sensitive-marker')) 'content must never be returned'
}
function Stage($request) { [IO.File]::WriteAllBytes((Join-Path $script:stage ($request.id + '.part')), $script:bytes) }
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    if (Test-Path -LiteralPath $WorkRoot) { throw 'fixture path already exists' }
    if ([string]::IsNullOrWhiteSpace($fixtureParent) -or !(Test-Path -LiteralPath $fixtureParent -PathType Container)) { throw 'fixture parent must exist' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Add-Type -Path (Join-Path $PSScriptRoot '../scripts/windows-file-native.cs') -ErrorAction Stop | Out-Null
    # A deny-only Administrators SID exercises the same guard as a filtered SSH token.
    # No account, credential, policy or machine setting is created or modified.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class RestrictedAdministratorTest {
    [StructLayout(LayoutKind.Sequential)]
    struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, ref SidAndAttributes disable,
        uint privilegeCount, IntPtr privileges, uint restrictCount, IntPtr restrict, out SafeAccessTokenHandle result);
    public static SafeAccessTokenHandle CreateToken() {
        byte[] bytes = new byte[68];
        SecurityIdentifier admin = new SecurityIdentifier("S-1-5-32-544");
        admin.GetBinaryForm(bytes, 0);
        GCHandle pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        SafeAccessTokenHandle restricted = null;
        try {
            SidAndAttributes sid = new SidAndAttributes { Sid = pin.AddrOfPinnedObject(), Attributes = 0 };
            using (WindowsIdentity current = WindowsIdentity.GetCurrent()) {
                if (!CreateRestrictedToken(current.Token, 0, 1, ref sid, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return restricted;
        } catch { if (restricted != null) restricted.Dispose(); throw; }
        finally { pin.Free(); }
    }
}
'@ | Out-Null
    [SshApproval.WindowsFiles]::RequireAdministrator()
    $restrictedToken = [RestrictedAdministratorTest]::CreateToken()
    try {
        [Security.Principal.WindowsIdentity]::RunImpersonated($restrictedToken, [Action] {
            $denied = $false
            try { [SshApproval.WindowsFiles]::RequireAdministrator() }
            catch {
                $failure = $_.Exception
                while ($null -ne $failure) {
                    if ($failure.PSObject.Properties['Code'] -and $failure.Code -ceq 'PERMISSION_DENIED') { $denied = $true; break }
                    $failure = $failure.InnerException
                }
            }
            Assert-True $denied 'deny-only Administrators token cannot request elevation'
        })
    } finally { $restrictedToken.Dispose() }
    $fixtureSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $sid + ')'
    [SshApproval.WindowsFiles]::CreatePrivateDirectory($WorkRoot, $fixtureSddl, $sid, $sid, $false)
    $fixtureCreated = $true
    Assert-True (Test-Path -LiteralPath $WorkRoot -PathType Container) 'default ProgramData parent supports protected directory creation'
    $install = Join-Path $WorkRoot 'helper'
    $script:stage = Join-Path $WorkRoot 'incoming'
    $root = Join-Path $WorkRoot 'files'
    $script:target = Join-Path $root 'result.bin'
    $installer = Join-Path $PSScriptRoot '../scripts/install-windows-helper.ps1'
    $arguments = '-AccountSid "' + $sid + '" -FileRoot "' + $root + '" -InstallRoot "' + $install + '" -StageRoot "' + $script:stage + '"'
    $installed = Invoke-Script $installer $arguments
    Assert-True ($installed.exitCode -eq 0 -and $installed.data.installed) 'new dedicated installation'
    $script:helper = $installed.data.helper
    $authorization = Request 'authorize'
    $authorization.elevate = $true
    $authorized = Call $authorization
    Assert-True ($authorized.exitCode -eq 0 -and $authorized.data.authorized -and $authorized.data.elevated) 'connected administrator token is authorized'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($authorization.id + '.part')))) 'authorization does not create a staged file'
    $reinstall = Invoke-Script $installer $arguments
    Assert-True ($reinstall.exitCode -eq 1 -and $reinstall.data.errorCode -eq 'DESTINATION_EXISTS') 'existing installation must be preserved'
    $unsafeParent = Join-Path $WorkRoot 'unsafe-parent'
    $null = [IO.Directory]::CreateDirectory($unsafeParent)
    $unsafeAcl = Get-Acl -LiteralPath $unsafeParent
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $unsafeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $unsafeParent -AclObject $unsafeAcl
    $unsafeSddl = (Get-Acl -LiteralPath $unsafeParent).Sddl
    $unsafeArguments = '-AccountSid "' + $sid + '" -FileRoot "' + (Join-Path $unsafeParent 'files') +
        '" -InstallRoot "' + (Join-Path $unsafeParent 'helper') + '" -StageRoot "' + (Join-Path $unsafeParent 'incoming') + '"'
    $refusedInstall = Invoke-Script $installer $unsafeArguments
    Assert-True ($refusedInstall.exitCode -eq 1 -and $refusedInstall.data.errorCode -ceq 'PERMISSION_DENIED') 'Users Modify ancestor must reject installation'
    Assert-True ((Get-Acl -LiteralPath $unsafeParent).Sddl -ceq $unsafeSddl) 'installer cannot change an unsafe parent ACL'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $unsafeParent 'helper'))) 'unsafe ancestry cannot create protected roots'
    $attributeParent = Join-Path $WorkRoot 'attribute-parent'
    $null = [IO.Directory]::CreateDirectory($attributeParent)
    $attributeAcl = Get-Acl -LiteralPath $attributeParent
    $attributeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        ([Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::CreateFiles),
        [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $attributeParent -AclObject $attributeAcl
    $attributeArguments = '-AccountSid "' + $sid + '" -FileRoot "' + (Join-Path $attributeParent 'files') +
        '" -InstallRoot "' + (Join-Path $attributeParent 'helper') + '" -StageRoot "' + (Join-Path $attributeParent 'incoming') + '"'
    $refusedAttributes = Invoke-Script $installer $attributeArguments
    Assert-True ($refusedAttributes.exitCode -eq 1 -and $refusedAttributes.data.errorCode -ceq 'PERMISSION_DENIED') 'attribute-writable final parent must reject installation'
    Assert-True (@(Get-ChildItem -LiteralPath $attributeParent -Force).Count -eq 0) 'attribute-writable empty parent remains unchanged'
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
    [IO.File]::SetCreationTimeUtc($script:target, [DateTime]::new(2020, 1, 2, 3, 4, 5, [DateTimeKind]::Utc))
    [IO.File]::SetLastAccessTimeUtc($script:target, [DateTime]::new(2021, 2, 3, 4, 5, 6, [DateTimeKind]::Utc))
    [IO.File]::SetLastWriteTimeUtc($script:target, [DateTime]::new(2022, 3, 4, 5, 6, 7, [DateTimeKind]::Utc))
    $times = @([IO.File]::GetCreationTimeUtc($script:target), [IO.File]::GetLastAccessTimeUtc($script:target), [IO.File]::GetLastWriteTimeUtc($script:target))
    $acl = (Get-Acl -LiteralPath $script:target).Sddl
    $owner = (Get-Acl -LiteralPath $script:target).Owner
    $request.elevate = $true
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('atomic overwrite; ' + (Describe-Result $result))
    Assert-True ((Get-Acl -LiteralPath $script:target).Sddl -ceq $acl) 'overwrite retains destination DACL'
    Assert-True ((Get-Acl -LiteralPath $script:target).Owner -ceq $owner) 'overwrite retains destination owner'
    Assert-True ([IO.File]::GetCreationTimeUtc($script:target) -eq $times[0] -and
        [IO.File]::GetLastAccessTimeUtc($script:target) -eq $times[1] -and
        [IO.File]::GetLastWriteTimeUtc($script:target) -eq $times[2]) 'overwrite retains creation access and write times after handle close'
    $reader = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    try {
        $result = Call $request
        Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('overwrite preserves shared-delete reader; ' + (Describe-Result $result))
        Assert-True ($reader.ReadByte() -eq $script:bytes[0]) 'replaced file remains readable through retained handle'
    } finally { $reader.Dispose() }
    $reader = [IO.File]::Open($script:target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { Refused $request 'PERMISSION_DENIED' } finally { $reader.Dispose() }
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:target)) -ceq [Convert]::ToBase64String($script:bytes)) 'blocked overwrite preserves destination bytes'
    $protectedAcl = Get-Acl -LiteralPath $script:target
    $protectedAcl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $script:target -AclObject $protectedAcl
    $protectedSddl = (Get-Acl -LiteralPath $script:target).Sddl
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and (Get-Acl -LiteralPath $script:target).Sddl -ceq $protectedSddl) 'overwrite retains protected destination DACL'
    $null = & icacls.exe $script:target /setintegritylevel 'L'
    Assert-True ($LASTEXITCODE -eq 0) 'fixture mandatory low integrity label is set'
    $labelBefore = (& icacls.exe $script:target) -join "`n"
    Assert-True ($LASTEXITCODE -eq 0) 'fixture mandatory label can be read'
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.published) ('overwrite retains mandatory label; ' + (Describe-Result $result))
    $labelAfter = (& icacls.exe $script:target) -join "`n"
    Assert-True ($LASTEXITCODE -eq 0 -and $labelAfter -ceq $labelBefore) 'overwrite cannot replace a mandatory low integrity label with its default label'
    $request.action = 'cleanup'
    $result = Call $request
    Assert-True ($result.exitCode -eq 0 -and $result.data.cleaned) 'cleanup staged data'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $script:stage ($request.id + '.part')))) 'cleanup removed only own stage'
    Assert-True ((Call $request).exitCode -eq 0) 'cleanup idempotent'

    $snapshot = Request 'snapshot'
    $snapshot.elevate = $true
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
    $invalid.elevate = 'true'
    Refused $invalid 'INVALID_REQUEST'
    Refused (Request 'authorize') 'INVALID_REQUEST'
    $invalid = Request
    $invalid.maxBytes = 1.5
    Refused $invalid 'INVALID_REQUEST'
    $result = Invoke-Script $script:helper '' ('x' * 16385)
    Assert-True ($result.exitCode -eq 1 -and $result.data.errorCode -ceq 'INVALID_REQUEST') 'bounded input'

    $originalParentAcl = Get-Acl -LiteralPath $WorkRoot
    $weakenedParentAcl = Get-Acl -LiteralPath $WorkRoot
    $weakenedParentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,
        [Security.AccessControl.FileSystemRights]::Modify, [Security.AccessControl.AccessControlType]::Allow))
    try {
        Set-Acl -LiteralPath $WorkRoot -AclObject $weakenedParentAcl
        Refused (Request 'snapshot') 'PERMISSION_DENIED'
    } finally { Set-Acl -LiteralPath $WorkRoot -AclObject $originalParentAcl }

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
