# 이 스크립트는 일회용 GitHub Windows 실행기 전용이다. 개발 PC에서 실행하지 않는다.
# 예상 자원: 실행기 1개, 최대 20분, 1 MiB 이하 전송, 외부 SSH 접속 없음.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw '이 시험은 일회용 GitHub Windows 실행기에서만 허용됩니다.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '격리 SSH 서버를 만들 실행기 관리자 권한이 필요합니다.'
}

$fixtureId = [Guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path $env:ProgramData ('ags-windows-ci-' + $fixtureId)
$clientRoot = Join-Path $fixtureRoot 'client'
$accountName = 'agsci' + $fixtureId.Substring(0, 12)
$taskName = 'AGS-Windows-SSH-' + $fixtureId
$registeredTask = $false
$createdUser = $false
$testsPassed = $false
$utf8 = [Text.UTF8Encoding]::new($false)
$sshd = Join-Path $env:WINDIR 'System32/OpenSSH/sshd.exe'
$keygen = Join-Path $env:WINDIR 'System32/OpenSSH/ssh-keygen.exe'
$serverLog = Join-Path $fixtureRoot 'sshd.log'

function Write-Utf8([string] $Path, [string] $Text) {
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Assert-Exit([string] $Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation 실패: 종료 코드 $LASTEXITCODE" }
}
function Write-ServerLogTail([int] $Lines = 60) {
    if (-not (Test-Path -LiteralPath $serverLog)) { return }
    $stream = $null
    $reader = $null
    try {
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.FileStream]::new($serverLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $reader = [IO.StreamReader]::new($stream, $utf8, $true)
        $tail = [Collections.Generic.Queue[string]]::new()
        while (-not $reader.EndOfStream) {
            $tail.Enqueue($reader.ReadLine())
            if ($tail.Count -gt $Lines) { $null = $tail.Dequeue() }
        }
        foreach ($line in $tail) { Write-Output $line }
    } catch {
        # 진단 실패가 일회 계정·키·서버 정리를 중단하거나 원래 시험 실패를 가리면 안 된다.
        Write-Output ('서버 로그 읽기 실패: ' + $_.Exception.GetType().Name + ', ' + $_.Exception.HResult)
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
    }
}
function Set-FixtureAcl([string] $Path, [string] $AccountSid, [string] $Rights = 'ReadAndExecute', [switch] $MachineOnly) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        $acl = [Security.AccessControl.FileSecurity]::new()
    }
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($acl -is [Security.AccessControl.DirectorySecurity]) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else { [Security.AccessControl.InheritanceFlags]::None }
    $owners = @('S-1-5-18', 'S-1-5-32-544')
    if (-not $MachineOnly) { $owners += $identity.User.Value }
    foreach ($sid in $owners | Select-Object -Unique) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', $inherit, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($AccountSid) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($AccountSid), $Rights, $inherit, 'None', 'Allow'))
    }
    $owner = if ($MachineOnly) { [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544') } else { $identity.User }
    $acl.SetOwner($owner)
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function New-ProfileConfig([string] $KeyPath, [string] $HostPin, [int] $Port) {
    $quotedKey = ConvertTo-Json -InputObject $KeyPath -Compress
    $profiles = foreach ($mode in @('read', 'write')) {
        $readOnly = if ($mode -eq 'read') { 'true' } else { 'false' }
        $role = if ($mode -eq 'read') { 'viewer' } else { 'operator' }
@"
[[profiles]]
name = "windows-$mode"
host = "127.0.0.1"
port = $Port
user = "$accountName"
auth = "key"
keyRef = $quotedKey
trustedHostKey = "$HostPin"
readOnly = $readOnly
group = "prod"
role = "$role"
announceAgent = false
tty = false
transferTimeoutMs = 10000
"@
    }
    return "[defaults]`ndefaultProfile = `"windows-write`"`ncommandTimeoutMs = 60000`n`n" + ($profiles -join "`n")
}

try {
    if (-not (Test-Path -LiteralPath $sshd)) {
        $capability = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
        if ($capability.RestartNeeded) { throw 'OpenSSH 설치가 재부팅을 요구하여 시험을 진행할 수 없습니다.' }
    }
    if (-not (Test-Path -LiteralPath $sshd) -or -not (Test-Path -LiteralPath $keygen)) {
        throw '실제 Windows OpenSSH 실행 파일이 없습니다.'
    }
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    Set-FixtureAcl $fixtureRoot ''
    $password = [Guid]::NewGuid().ToString('N') + 'aA1!'
    $user = New-LocalUser -Name $accountName -Password (ConvertTo-SecureString $password -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires
    $createdUser = $true
    $password = $null
    $accountSid = $user.SID.Value
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $accountName
    Set-FixtureAcl $fixtureRoot $accountSid
    New-Item -ItemType Directory -Path $clientRoot | Out-Null
    Set-FixtureAcl $clientRoot ''

    $clientKey = Join-Path $clientRoot 'client_key'
    $wrongKey = Join-Path $clientRoot 'wrong_key'
    $hostKey = Join-Path $fixtureRoot 'host_key'
    foreach ($keyPath in @($clientKey, $wrongKey, $hostKey)) {
        & $keygen -q -t ed25519 -N '' -f $keyPath
        Assert-Exit '일회용 키 생성'
        Set-FixtureAcl $keyPath ''
    }
    # SYSTEM으로 실행되는 sshd의 호스트 키는 개별 runner 계정의 ACE도 허용하지 않는다.
    Set-FixtureAcl $hostKey '' -MachineOnly
    $authorizedKeys = Join-Path $fixtureRoot 'authorized_keys'
    Write-Utf8 $authorizedKeys ([IO.File]::ReadAllText($clientKey + '.pub'))
    Set-FixtureAcl $authorizedKeys $accountSid -MachineOnly
    $fingerprint = (& $keygen -lf ($hostKey + '.pub') -E sha256) -match 'SHA256:[A-Za-z0-9+/]+'
    Assert-Exit '호스트 키 지문 계산'
    if (-not $fingerprint) { throw '호스트 키 지문을 계산하지 못했습니다.' }
    $hostPin = $Matches[0]
    $wrongFingerprint = (& $keygen -lf ($wrongKey + '.pub') -E sha256) -match 'SHA256:[A-Za-z0-9+/]+'
    Assert-Exit '거부 시험용 호스트 키 지문 계산'
    if (-not $wrongFingerprint) { throw '거부 시험용 키 지문을 계산하지 못했습니다.' }
    $wrongHostPin = $Matches[0]

    $installRoot = Join-Path $fixtureRoot 'installed-helper'
    $fileRoot = Join-Path $fixtureRoot 'approved-files'
    $stageRoot = Join-Path $fixtureRoot 'incoming'
    $installer = Join-Path $PSScriptRoot '../scripts/install-windows-helper.ps1'
    $installOutput = Join-Path $clientRoot 'install-result.json'
    $installError = Join-Path $clientRoot 'install-error.txt'
    $installProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -Wait -PassThru `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            ('"' + $installer + '"'), '-AccountSid', $accountSid, '-FileRoot', ('"' + $fileRoot + '"'),
            '-InstallRoot', ('"' + $installRoot + '"'), '-StageRoot', ('"' + $stageRoot + '"')) `
        -RedirectStandardOutput $installOutput -RedirectStandardError $installError
    $installed = [IO.File]::ReadAllText($installOutput, $utf8) | ConvertFrom-Json
    if ($installProcess.ExitCode -ne 0) { throw ('파일 보조프로그램 설치 실패: ' + $installed.errorCode) }
    if ($installed.installed -ne $true) { throw '파일 보조프로그램 설치 결과가 유효하지 않습니다.' }
    $outsideRoot = Join-Path $fixtureRoot 'outside'
    New-Item -ItemType Directory -Path $outsideRoot | Out-Null
    Set-FixtureAcl $outsideRoot $accountSid 'Modify'
    $outsideFile = Join-Path $outsideRoot 'outside.bin'
    Write-Utf8 $outsideFile '영역 밖 원본'
    New-Item -ItemType Junction -Path (Join-Path $fileRoot 'junction') -Target $outsideRoot | Out-Null
    New-Item -ItemType SymbolicLink -Path (Join-Path $fileRoot 'symlink.bin') -Target $outsideFile | Out-Null

    # 시스템/사용자 모듈 폴더를 건드리지 않고 이 exec 프로세스의 오염된 검색 경로만 합성한다.
    $modulesRoot = Join-Path $fixtureRoot 'modules'
    New-Item -ItemType Directory -Path $modulesRoot | Out-Null
    Set-FixtureAcl $modulesRoot $accountSid
    $moduleMarkers = @()
    foreach ($module in @(
        @{ name = 'Microsoft.PowerShell.Utility'; command = 'Get-Date'; marker = 'utility-autoload-marker.txt' },
        @{ name = 'Microsoft.PowerShell.Management'; command = 'Get-Location'; marker = 'management-autoload-marker.txt' }
    )) {
        $moduleRoot = Join-Path $modulesRoot $module.name
        New-Item -ItemType Directory -Path $moduleRoot | Out-Null
        $markerPath = Join-Path $fileRoot $module.marker
        $moduleMarkers += $markerPath
        $body = "[IO.File]::WriteAllText('$markerPath', 'untrusted module loaded')`n" +
            "function $($module.command) { 'untrusted module loaded' }`n" +
            "Export-ModuleMember -Function '$($module.command)'`n"
        Write-Utf8 (Join-Path $moduleRoot ($module.name + '.psm1')) $body
        $manifest = "@{ RootModule = '$($module.name).psm1'; ModuleVersion = '1.0.0'; " +
            "FunctionsToExport = @('$($module.command)'); CmdletsToExport = @(); AliasesToExport = @() }"
        Write-Utf8 (Join-Path $moduleRoot ($module.name + '.psd1')) $manifest
    }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $serverConfig = Join-Path $fixtureRoot 'sshd_config'
    $hostPath = $hostKey.Replace('\', '/')
    $authPath = $authorizedKeys.Replace('\', '/')
    $sftpPath = (Join-Path (Split-Path $sshd) 'sftp-server.exe').Replace('\', '/')
    Write-Utf8 $serverConfig @"
Port $port
ListenAddress 127.0.0.1
HostKey $hostPath
AuthorizedKeysFile $authPath
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
AllowUsers $accountName
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
LogLevel VERBOSE
Subsystem sftp $sftpPath
"@
    Set-FixtureAcl $serverConfig '' -MachineOnly
    & $sshd -t -f $serverConfig
    Assert-Exit '격리 SSH 서버 설정 검사'
    # SSH 서버는 SYSTEM 권한이 필요하다. 기존 sshd 서비스나 기본 셸은 바꾸지 않는다.
    $action = New-ScheduledTaskAction -Execute $sshd -Argument "-D -f `"$serverConfig`" -E `"$serverLog`""
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $taskPrincipal -Settings $settings | Out-Null
    $registeredTask = $true
    Start-ScheduledTask -TaskName $taskName
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        $socket = [Net.Sockets.TcpClient]::new()
        try {
            if ($socket.ConnectAsync('127.0.0.1', $port).Wait(200) -and $socket.Connected) {
                $ready = $true
                break
            }
        }
        catch { Start-Sleep -Milliseconds 100 }
        finally { $socket.Dispose() }
    }
    if (-not $ready) {
        Write-ServerLogTail 30
        throw '격리 SSH 서버가 준비되지 않았습니다.'
    }

    $configPath = Join-Path $clientRoot 'profiles.toml'
    $wrongClientConfig = Join-Path $clientRoot 'wrong-client.toml'
    $wrongHostConfig = Join-Path $clientRoot 'wrong-host.toml'
    Write-Utf8 $configPath (New-ProfileConfig $clientKey $hostPin $port)
    Write-Utf8 $wrongClientConfig (New-ProfileConfig $wrongKey $hostPin $port)
    Write-Utf8 $wrongHostConfig (New-ProfileConfig $clientKey $wrongHostPin $port)
    foreach ($path in @($configPath, $wrongClientConfig, $wrongHostConfig)) { Set-FixtureAcl $path '' }
    $fixturePath = Join-Path $clientRoot 'fixture.json'
    $artifactRoot = Join-Path $clientRoot 'artifacts'
    Write-Utf8 $fixturePath (@{
        configPath = $configPath; wrongClientConfig = $wrongClientConfig; wrongHostConfig = $wrongHostConfig
        helper = $installed.helper; stageRoot = $installed.stageRoot; fileRoot = $installed.fileRoot
        artifactRoot = $artifactRoot; outsideFile = $outsideFile
        modulesRoot = $modulesRoot; moduleMarkers = $moduleMarkers
    } | ConvertTo-Json -Compress)
    Set-FixtureAcl $fixturePath ''
    $env:AGS_WINDOWS_SSH_FIXTURE = $fixturePath
    & node --test (Join-Path $PSScriptRoot 'windows-ssh-integration.test.mjs')
    Assert-Exit '실제 Windows SSH 통합 시험'
    $testsPassed = $true
    Write-Output '실제 Windows OpenSSH 통합 시험 통과'
} finally {
    Remove-Item Env:AGS_WINDOWS_SSH_FIXTURE -ErrorAction SilentlyContinue
    if ($registeredTask) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Continue
        # 예약 작업의 잔존 자식도 해당 격리 설정 경로를 기준으로만 정리한다.
        Get-CimInstance Win32_Process -Filter "Name = 'sshd.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($fixtureRoot)
        } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Continue
    }
    if (-not $testsPassed) {
        # 서버 종료 뒤에도 공유 읽기를 사용한다. 비밀키·암호는 로그에 기록되지 않는다.
        Write-ServerLogTail
    }
    if ($createdUser) { Remove-LocalUser -Name $accountName -ErrorAction Continue }
    if (Test-Path -LiteralPath $fixtureRoot) {
        $resolved = [IO.Path]::GetFullPath($fixtureRoot)
        $expected = [IO.Path]::GetFullPath((Join-Path $env:ProgramData ('ags-windows-ci-' + $fixtureId)))
        if ($resolved -ne $expected -or (Split-Path $resolved -Leaf) -ne ('ags-windows-ci-' + $fixtureId)) {
            throw '격리 시험 경로 검증 실패로 자동 정리를 중단했습니다.'
        }
        # 재분석 지점은 대상을 따라가지 않도록 먼저 해당 링크만 제거한다.
        $junction = Join-Path $fixtureRoot 'approved-files/junction'
        if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
