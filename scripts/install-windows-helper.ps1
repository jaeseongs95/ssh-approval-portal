# Run elevated once, for new dedicated directories. No account, key or sshd changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AccountSid,
    [Parameter(Mandatory = $true)][string]$FileRoot,
    [string]$InstallRoot = 'C:/ProgramData/ssh-approval-portal',
    [string]$StageRoot = 'C:/ProgramData/ssh-approval-transfer/incoming'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$leases = [Collections.Generic.List[IDisposable]]::new()
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'PERMISSION_DENIED' }
    $sid = [Security.Principal.SecurityIdentifier]::new($AccountSid)
    # Resolve a real local/domain account; never turn an untrusted name into SDDL.
    $null = $sid.Translate([Security.Principal.NTAccount])
    if ($sid.Value -notmatch '^S-1-5-21-[0-9-]+$') { throw 'INVALID_REQUEST' }
    $AccountSid = $sid.Value
    $installerSid = $identity.User.Value
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-file-native.cs') -ErrorAction Stop | Out-Null
    $InstallRoot = [SshApproval.WindowsFiles]::CheckedPath($InstallRoot)
    $StageRoot = [SshApproval.WindowsFiles]::CheckedPath($StageRoot)
    $FileRoot = [SshApproval.WindowsFiles]::CheckedPath($FileRoot)
    $paths = @($InstallRoot, $StageRoot, $FileRoot)
    for ($i = 0; $i -lt $paths.Count; $i++) {
        if (Test-Path -LiteralPath $paths[$i]) { throw 'DESTINATION_EXISTS' }
        for ($j = 0; $j -lt $paths.Count; $j++) {
            if ($i -ne $j -and ($paths[$i].Equals($paths[$j], [StringComparison]::OrdinalIgnoreCase) -or
                $paths[$i].StartsWith($paths[$j] + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'INVALID_REQUEST' }
        }
    }
    $admin = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    $read = $admin + '(A;OICI;0x1200a9;;;' + $AccountSid + ')'
    $modify = $admin + '(A;OICI;0x1301bf;;;' + $AccountSid + ')'
    # Only this dedicated default parent may be made implicitly. Custom parents must exist.
    $defaultParent = 'C:\ProgramData\ssh-approval-transfer'
    if ($StageRoot.Equals($defaultParent + '\incoming', [StringComparison]::OrdinalIgnoreCase) -and
        !(Test-Path -LiteralPath $defaultParent)) {
        [SshApproval.WindowsFiles]::CreatePrivateDirectory($defaultParent, $read, $AccountSid, $installerSid, $false)
    }
    foreach ($path in $paths) {
        if (!(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($path)) -PathType Container)) { throw 'PARENT_NOT_FOUND' }
        $trustAccount = !$path.Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase)
        $leases.Add([SshApproval.WindowsFiles]::PinTrustedDirectory([IO.Path]::GetDirectoryName($path), $AccountSid, $installerSid, $trustAccount))
    }
    [SshApproval.WindowsFiles]::CreatePrivateDirectory($InstallRoot, $read, $AccountSid, $installerSid, $false)
    $leases.Add([SshApproval.WindowsFiles]::PinTrustedDirectory($InstallRoot, $AccountSid, $installerSid, $false))
    [SshApproval.WindowsFiles]::CreatePrivateDirectory($StageRoot, $modify, $AccountSid, $installerSid, $true)
    $leases.Add([SshApproval.WindowsFiles]::PinTrustedDirectory($StageRoot, $AccountSid, $installerSid, $true))
    [SshApproval.WindowsFiles]::CreatePrivateDirectory($FileRoot, $modify, $AccountSid, $installerSid, $true)
    $leases.Add([SshApproval.WindowsFiles]::PinTrustedDirectory($FileRoot, $AccountSid, $installerSid, $true))
    # Creation above supplies the final ACL atomically; there is no permissive intermediate ACL.
    foreach ($name in @('windows-file-helper.ps1', 'windows-file-native.cs')) {
        [IO.File]::Copy((Join-Path $PSScriptRoot $name), (Join-Path $InstallRoot $name), $false)
    }
    $config = @{ version = 1; accountSid = $AccountSid; installerSid = $installerSid; fileRoot = $FileRoot; stageRoot = $StageRoot } | ConvertTo-Json -Compress
    $configPath = Join-Path $InstallRoot 'windows-file-helper.config.json'
    $stream = [IO.File]::Open($configPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($config)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    [Console]::Out.WriteLine((@{ installed = $true; helper = (Join-Path $InstallRoot 'windows-file-helper.ps1');
        stageRoot = $StageRoot; fileRoot = $FileRoot; accountSid = $AccountSid } | ConvertTo-Json -Compress))
    exit 0
} catch {
    $code = 'OPERATION_FAILED'
    $failure = $_.Exception
    $codes = @('PARENT_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS', 'UNSAFE_PATH', 'INVALID_REQUEST', 'OPERATION_FAILED')
    while ($null -ne $failure) {
        if ($failure.PSObject.Properties['Code'] -and $failure.Code -cin $codes) { $code = $failure.Code; break }
        if ($failure.Message -cin $codes) { $code = $failure.Message; break }
        $failure = $failure.InnerException
    }
    [Console]::Out.WriteLine('{"error":"Helper installation refused or failed","errorCode":"' + $code + '"}')
    exit 1
} finally {
    for ($i = $leases.Count - 1; $i -ge 0; $i--) { $leases[$i].Dispose() }
}
