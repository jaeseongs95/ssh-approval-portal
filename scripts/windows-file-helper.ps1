# stdin/stdout are a metadata-only protocol. Never print request data or exceptions.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $buffer = New-Object char[] 16385
    $count = 0
    try {
        while ($count -lt $buffer.Length) {
            $read = [Console]::In.Read($buffer, $count, $buffer.Length - $count)
            if ($read -eq 0) { break }
            $count += $read
        }
        $raw = [string]::new($buffer, 0, $count)
        if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 16384) { throw 'INVALID_REQUEST' }
        $request = ConvertFrom-Json -InputObject $raw
    } catch { throw 'INVALID_REQUEST' }
    if ($null -eq $request -or $request -isnot [pscustomobject] -or
        $request.id -isnot [string] -or $request.id -cnotmatch '^[a-f0-9]{48}$' -or
        $request.action -cnotin @('publish', 'snapshot', 'cleanup')) { throw 'INVALID_REQUEST' }
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
    if ($config.version -ne 1 -or $config.accountSid -isnot [string]) { throw 'OPERATION_FAILED' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.User.Value -ne $config.accountSid) { throw 'PERMISSION_DENIED' }
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-file-native.cs') -ErrorAction Stop | Out-Null
    $result = [SshApproval.WindowsFiles]::Execute($request.action, $request.id, $request.remotePath,
        $request.sha256, $size, $maximum, $overwrite, $config.fileRoot, $config.stageRoot, $config.accountSid)
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
    exit 0
} catch {
    $codes = @('PARENT_NOT_FOUND', 'FILE_NOT_FOUND', 'PERMISSION_DENIED', 'DESTINATION_EXISTS',
        'UNSAFE_PATH', 'STAGING_UNAVAILABLE', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'INVALID_REQUEST', 'OPERATION_FAILED')
    $code = 'OPERATION_FAILED'
    $failure = $_.Exception
    while ($null -ne $failure) {
        if ($failure.PSObject.Properties['Code'] -and $failure.Code -cin $codes) { $code = $failure.Code; break }
        if ($failure.Message -cin $codes) { $code = $failure.Message; break }
        $failure = $failure.InnerException
    }
    [Console]::Out.WriteLine('{"error":"File operation refused or failed","errorCode":"' + $code + '"}')
    exit 1
}
