# 실행 중인 격리 sshd 로그에서 원문 없는 고정 사건만 공유 읽기로 돌려준다.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $LogPath,
    [ValidateRange(0, 2147483647)][int] $FromLine = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'CI_WINDOWS_ONLY' }
$resolved = [IO.Path]::GetFullPath($LogPath)
$parent = [IO.Path]::GetDirectoryName($resolved)
if ([IO.Path]::GetFileName($resolved) -cne 'sshd.log' -or
    [IO.Path]::GetFileName($parent) -cnotmatch '^ags-windows-ci-[a-f0-9]{32}$' -or
    [IO.Path]::GetDirectoryName($parent).TrimEnd('\') -ine $env:ProgramData.TrimEnd('\')) {
    throw 'FIXTURE_LOG_REQUIRED'
}
$stream = $null
$reader = $null
try {
    $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.FileStream]::new($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
    $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
    $events = [Collections.Generic.Queue[object]]::new()
    $lineCount = 0
    $pattern = 'Connection from 127\.0\.0\.1 port \d+ on 127\.0\.0\.1 port \d+|User child is on pid \d+|Starting session: command for [a-z0-9]+ from 127\.0\.0\.1 port \d+ id \d+|channel \d+: (rcvd eof|send eof|input drain -> closed|output drain -> closed)'
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        $lineCount++
        if ($lineCount -gt $FromLine -and $line -match $pattern) {
            $events.Enqueue(@{ line = $lineCount; event = $Matches[0] })
            if ($events.Count -gt 256) { $null = $events.Dequeue() }
        }
    }
    [Console]::Out.WriteLine((@{ lineCount = $lineCount; events = @($events.ToArray()) } | ConvertTo-Json -Depth 4 -Compress))
} catch {
    $cause = $_.Exception.GetBaseException()
    $report = @{ errorCode = 'LOG_READ_FAILED'; errorType = $cause.GetType().Name; hresult = $cause.HResult }
    if (($cause.HResult -shr 16 -band 8191) -eq 7) { $report.nativeError = $cause.HResult -band 65535 }
    [Console]::Out.WriteLine(($report | ConvertTo-Json -Compress))
    exit 1
} finally {
    if ($null -ne $reader) { $reader.Dispose() }
    elseif ($null -ne $stream) { $stream.Dispose() }
}
