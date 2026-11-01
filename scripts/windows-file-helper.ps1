# stdin/stdout are a metadata-only protocol. Never print request data or exceptions.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installLease = $null
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-file-native.cs') -ErrorAction Stop | Out-Null
    $raw = [SshApproval.WindowsFiles]::ReadMetadataInput()
    try {
        $request = ConvertFrom-Json -InputObject $raw
    } catch { throw 'INVALID_REQUEST' }
    if ($null -eq $request -or $request -isnot [pscustomobject] -or
        $request.id -isnot [string] -or $request.id -cnotmatch '^[a-f0-9]{48}$' -or
        $request.action -cnotin @('publish', 'snapshot', 'cleanup', 'authorize')) { throw 'INVALID_REQUEST' }
    $elevate = $false
    if ($null -ne $request.PSObject.Properties['elevate']) {
        if ($request.elevate -isnot [bool]) { throw 'INVALID_REQUEST' }
        $elevate = $request.elevate
    }
    if ($request.action -eq 'authorize' -and !$elevate) { throw 'INVALID_REQUEST' }
    $maximum = 67108864L
    if ($null -ne $request.PSObject.Properties['maxBytes']) {
        if (($request.maxBytes -isnot [int] -and $request.maxBytes -isnot [long]) -or
            $request.maxBytes -le 0 -or $request.maxBytes -gt $maximum) { throw 'INVALID_REQUEST' }
        $maximum = [long]$request.maxBytes
    }
    $size = 0L
    $overwrite = $false
    if ($request.action -eq 'publish') {
        if ($request.overwrite -isnot [bool] -or $request.sha256 -isnot [string] -or
            $request.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            ($request.size -isnot [int] -and $request.size -isnot [long]) -or
            $request.size -lt 0 -or $request.size -gt $maximum) { throw 'INVALID_REQUEST' }
        $size = [long]$request.size
        $overwrite = $request.overwrite
    }
    if ($request.action -ne 'cleanup' -and $request.remotePath -isnot [string]) { throw 'UNSAFE_PATH' }
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-file-helper.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.version -ne 1 -or $config.accountSid -isnot [string] -or
        $config.installerSid -isnot [string] -or $config.installerSid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'OPERATION_FAILED' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $config.accountSid) { throw 'PERMISSION_DENIED' }
    if ($elevate) { [SshApproval.WindowsFiles]::RequireAdministrator() }
    $installLease = [SshApproval.WindowsFiles]::PinTrustedDirectory($PSScriptRoot, $config.accountSid, $config.installerSid, $false)
    if ($request.action -eq 'authorize') {
        [Console]::Out.WriteLine('{"authorized":true,"elevated":true}')
        exit 0
    }
    $result = [SshApproval.WindowsFiles]::Execute($request.action, $request.id, $request.remotePath,
        $request.sha256, $size, $maximum, $overwrite, $config.fileRoot, $config.stageRoot, $config.accountSid, $config.installerSid)
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
    exit 0
} catch {
    $codes = @('PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS',
        'UNSAFE_PATH', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED')
    $code = 'OPERATION_FAILED'
    $nativeStep = $null
    $nativeError = 0
    $securityControl = $null
    $failure = $_.Exception
    while ($null -ne $failure) {
        if ($failure.PSObject.Properties['Code'] -and $failure.Code -cin $codes) {
            $code = $failure.Code
            if ($failure.PSObject.Properties['NativeStep'] -and $failure.NativeStep -cin @('native', 'create_directory',
                'inspect', 'open', 'filesystem', 'final_path', 'read_input', 'read_security', 'remove', 'rename_replace', 'rename_new', 'write_security', 'write_times', 'verify_security', 'verify_owner', 'verify_dacl', 'verify_control', 'verify_times', 'read_label', 'write_label', 'verify_label') -and
                $failure.NativeError -is [int] -and $failure.NativeError -ge 0) {
                $nativeStep = $failure.NativeStep
                $nativeError = $failure.NativeError
                if ($nativeStep -cin @('verify_owner', 'verify_dacl', 'verify_control') -and
                    $failure.SecurityControlBefore -is [int] -and $failure.SecurityControlBefore -ge 0 -and $failure.SecurityControlBefore -le 5388 -and
                    $failure.SecurityControlAfter -is [int] -and $failure.SecurityControlAfter -ge 0 -and $failure.SecurityControlAfter -le 5388) {
                    $securityControl = @{ before = $failure.SecurityControlBefore; after = $failure.SecurityControlAfter }
                }
            }
            break
        }
        if ($failure.Message -cin $codes) { $code = $failure.Message; break }
        $failure = $failure.InnerException
    }
    $response = @{ error = 'File operation refused or failed'; errorCode = $code }
    if ($null -ne $nativeStep) { $response.nativeStep = $nativeStep; $response.nativeError = $nativeError }
    if ($null -ne $securityControl) { $response.securityControl = $securityControl }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
    exit 1
} finally {
    if ($null -ne $installLease) { $installLease.Dispose() }
}
