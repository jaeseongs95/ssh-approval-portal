# 이 스크립트는 일회용 GitHub Windows 실행기 전용이다. 개발 PC에서 실행하지 않는다.
# 예상 자원: 실행기 1개, 기본 최대 20분/전송 1 MiB 이하, 외부 SSH 접속 없음.
# 명시 선택한 실제 CLI 패키지 시험만 최대 40분이며 공식 고정 패키지를 내려받는다.
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
$adminName = 'agsad' + $fixtureId.Substring(0, 12)
$taskName = 'AGS-Windows-SSH-' + $fixtureId
$registeredTask = $false
$createdUser = $false
$createdAdmin = $false
$testsPassed = $false
$cleanupErrors = [Collections.Generic.List[string]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)
$sshd = Join-Path $env:WINDIR 'System32/OpenSSH/sshd.exe'
$keygen = Join-Path $env:WINDIR 'System32/OpenSSH/ssh-keygen.exe'
$sshClient = Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
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
        $channelEvents = [Collections.Generic.Queue[string]]::new()
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            # DEBUG2 원문에는 명령이 포함될 수 있으므로 고정 채널 사건만 따로 추출한다.
            if ($line -match 'channel [0-9]+: (rcvd eof|send eof|input drain -> closed|output drain -> closed)') {
                $channelEvents.Enqueue($Matches[0])
                if ($channelEvents.Count -gt 512) { $null = $channelEvents.Dequeue() }
            }
            if ($line -notmatch 'Accepted publickey|Starting session:|Close session:|Disconnected from|Connection closed|error:|fatal:') { continue }
            $tail.Enqueue($line)
            if ($tail.Count -gt $Lines) { $null = $tail.Dequeue() }
        }
        foreach ($line in $tail) { Write-Output $line }
        Write-Output '격리 서버 채널 EOF 사건(명령·입력 원문 제외):'
        foreach ($line in $channelEvents) { Write-Output $line }
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
function New-ProfileConfig([string] $KeyPath, [string] $HostPin, [int] $Port, [string] $UserName = $accountName, [string] $ProfilePrefix = 'windows') {
    $quotedKey = ConvertTo-Json -InputObject $KeyPath -Compress
    $profiles = foreach ($mode in @('read', 'write')) {
        $readOnly = if ($mode -eq 'read') { 'true' } else { 'false' }
        $role = if ($mode -eq 'read') { 'viewer' } else { 'operator' }
@"
[[profiles]]
name = "$ProfilePrefix-$mode"
host = "127.0.0.1"
port = $Port
user = "$UserName"
auth = "key"
keyRef = $quotedKey
trustedHostKey = "$HostPin"
readOnly = $readOnly
group = "prod"
role = "$role"
announceAgent = false
tty = false
transferTimeoutMs = 60000
"@
    }
    return "[defaults]`ndefaultProfile = `"$ProfilePrefix-write`"`ncommandTimeoutMs = 60000`n`n" + ($profiles -join "`n")
}
function Install-FixtureHelper([string] $Sid, [string] $Prefix = '') {
    $installer = Join-Path $PSScriptRoot '../scripts/install-windows-helper.ps1'
    $installOutput = Join-Path $clientRoot ($Prefix + 'install-result.json')
    $installError = Join-Path $clientRoot ($Prefix + 'install-error.txt')
    $installRoot = Join-Path $fixtureRoot ($Prefix + 'installed-helper')
    $fileRoot = Join-Path $fixtureRoot ($Prefix + 'approved-files')
    $stageRoot = Join-Path $fixtureRoot ($Prefix + 'incoming')
    $installProcess = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -Wait -PassThru `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            ('"' + $installer + '"'), '-AccountSid', $Sid, '-FileRoot', ('"' + $fileRoot + '"'),
            '-InstallRoot', ('"' + $installRoot + '"'), '-StageRoot', ('"' + $stageRoot + '"')) `
        -RedirectStandardOutput $installOutput -RedirectStandardError $installError
    $installed = [IO.File]::ReadAllText($installOutput, $utf8) | ConvertFrom-Json
    if ($installProcess.ExitCode -ne 0) { throw ('파일 보조프로그램 설치 실패: ' + $installed.errorCode) }
    if ($installed.installed -ne $true) { throw '파일 보조프로그램 설치 결과가 유효하지 않습니다.' }
    return $installed
}

try {
    if (-not (Test-Path -LiteralPath $sshd)) {
        $capability = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
        if ($capability.RestartNeeded) { throw 'OpenSSH 설치가 재부팅을 요구하여 시험을 진행할 수 없습니다.' }
    }
    if (-not (Test-Path -LiteralPath $sshd) -or -not (Test-Path -LiteralPath $keygen) -or -not (Test-Path -LiteralPath $sshClient)) {
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
    $adminPassword = [Guid]::NewGuid().ToString('N') + 'aA1!'
    $adminUser = New-LocalUser -Name $adminName -Password (ConvertTo-SecureString $adminPassword -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires
    $createdAdmin = $true
    $adminPassword = $null
    $adminSid = $adminUser.SID.Value
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) -Member $adminName
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

    $installed = Install-FixtureHelper $accountSid
    $fileRoot = $installed.fileRoot
    $stageRoot = $installed.stageRoot
    $adminInstalled = Install-FixtureHelper $adminSid 'admin-'
    $pythonCandidate = @(Get-Command python.exe -CommandType Application -ErrorAction Stop)[0]
    [string] $pythonExecutable = [IO.Path]::GetFullPath([string]$pythonCandidate.Source)
    if (-not [IO.File]::Exists($pythonExecutable)) { throw '명시한 Python 실행 파일이 없습니다.' }
    @{ pythonExecutable = $pythonExecutable; valueType = $pythonExecutable.GetType().FullName } | ConvertTo-Json -Compress
    $env:SOLID_PYTHON = $pythonExecutable
    $outsideRoot = Join-Path $fixtureRoot 'outside'
    New-Item -ItemType Directory -Path $outsideRoot | Out-Null
    # The destination writer allowlist is the SSH account, SYSTEM and Administrators.
    # The elevated runner keeps access through Administrators, not a separate writer ACE.
    Set-FixtureAcl $outsideRoot $accountSid 'Modify' -MachineOnly
    $outsideFile = Join-Path $outsideRoot 'outside.bin'
    Write-Utf8 $outsideFile '영역 밖 원본'

    # Keep the existing controlled positive destination. Separate fixtures retain
    # inherit-only Creator Owner and ordinary inherited Users create ACEs instead
    # of repairing the live-style ACL until it becomes an artificial success.
    $writerIoRoot = Join-Path $fixtureRoot 'writer-io-only'
    New-Item -ItemType Directory -Path $writerIoRoot | Out-Null
    Set-FixtureAcl $writerIoRoot $accountSid 'Modify' -MachineOnly
    $creatorOwner = [Security.Principal.SecurityIdentifier]::new('S-1-3-0')
    $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $ioAcl = Get-Acl -LiteralPath $writerIoRoot
    $ioAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($creatorOwner, 'FullControl',
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $writerIoRoot -AclObject $ioAcl

    $writerDefaultParent = Join-Path $fixtureRoot 'writer-default-parent'
    New-Item -ItemType Directory -Path $writerDefaultParent | Out-Null
    Set-FixtureAcl $writerDefaultParent $accountSid 'Modify' -MachineOnly
    $defaultAcl = Get-Acl -LiteralPath $writerDefaultParent
    $defaultAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, 'ReadAndExecute',
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    foreach ($rights in @([Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.FileSystemRights]::CreateDirectories)) {
        $defaultAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, $rights,
            [Security.AccessControl.InheritanceFlags]::ContainerInherit,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $writerDefaultParent -AclObject $defaultAcl
    $writerDefaultChild = Join-Path $writerDefaultParent 'inherited-child'
    New-Item -ItemType Directory -Path $writerDefaultChild | Out-Null
    # Add CO after child creation so no separate runner writer ACE can become an
    # alternative refusal cause. The Users create ACEs stay genuinely inherited.
    $childAcl = Get-Acl -LiteralPath $writerDefaultChild
    $childAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($creatorOwner, 'FullControl',
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $writerDefaultChild -AclObject $childAcl
    $writerAclFixtures = foreach ($directory in @($writerIoRoot, $writerDefaultChild)) {
        $sddl = [string](Get-Acl -LiteralPath $directory).Sddl
        $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
        $aces = foreach ($ace in $descriptor.DiscretionaryAcl) {
            if ($ace -isnot [Security.AccessControl.QualifiedAce]) { throw 'writer fixture unsupported ACE' }
            $actor = if ($ace.SecurityIdentifier.Value -ceq 'S-1-3-0') { 'creator-owner' }
                elseif ($ace.SecurityIdentifier.Value -ceq 'S-1-5-32-545') { 'users' } else { 'trusted' }
            @{ actor = $actor; kind = $ace.AceQualifier.ToString(); flags = [int]$ace.AceFlags; mask = [int]$ace.AccessMask }
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $aclHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sddl))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        @{ directory = $directory; aclSha256 = $aclHash; aces = @($aces) }
    }
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
    $knownHosts = Join-Path $clientRoot 'known_hosts'
    $nativeClientConfig = Join-Path $clientRoot 'ssh_config'
    Write-Utf8 $knownHosts ("[127.0.0.1]:$port " + [IO.File]::ReadAllText($hostKey + '.pub').Trim() + "`n")
    Write-Utf8 $nativeClientConfig @"
Host ags-fixture
    HostName 127.0.0.1
    Port $port
    User $accountName
    IdentityFile "$($clientKey.Replace('\', '/'))"
    UserKnownHostsFile "$($knownHosts.Replace('\', '/'))"
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    BatchMode yes
    LogLevel ERROR
"@
    Set-FixtureAcl $knownHosts ''
    Set-FixtureAcl $nativeClientConfig ''
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
AllowUsers $accountName $adminName
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
LogLevel DEBUG2
Subsystem sftp $sftpPath
"@
    Set-FixtureAcl $serverConfig '' -MachineOnly
    & $sshd -t -f $serverConfig
    Assert-Exit '격리 SSH 서버 설정 검사'
    # SSH 서버는 SYSTEM 권한이 필요하다. 기존 sshd 서비스나 기본 셸은 바꾸지 않는다.
    $action = New-ScheduledTaskAction -Execute $sshd -Argument "-D -f `"$serverConfig`" -E `"$serverLog`""
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $serverMinutes = if ($env:AGS_WINDOWS_CLI_PACKAGE_SMOKE -eq '1') { 35 } else { 10 }
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $serverMinutes)
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
    $adminConfigPath = Join-Path $clientRoot 'admin-profiles.toml'
    Write-Utf8 $configPath (New-ProfileConfig $clientKey $hostPin $port)
    Write-Utf8 $wrongClientConfig (New-ProfileConfig $wrongKey $hostPin $port)
    Write-Utf8 $wrongHostConfig (New-ProfileConfig $clientKey $wrongHostPin $port)
    Write-Utf8 $adminConfigPath (New-ProfileConfig $clientKey $hostPin $port $adminName 'admin')
    foreach ($path in @($configPath, $wrongClientConfig, $wrongHostConfig, $adminConfigPath)) { Set-FixtureAcl $path '' }
    $fixturePath = Join-Path $clientRoot 'fixture.json'
    $artifactRoot = Join-Path $clientRoot 'artifacts'
    Write-Utf8 $fixturePath (@{
        configPath = $configPath; wrongClientConfig = $wrongClientConfig; wrongHostConfig = $wrongHostConfig
        helper = $installed.helper; stageRoot = $installed.stageRoot; fileRoot = $installed.fileRoot
        artifactRoot = $artifactRoot; outsideFile = $outsideFile
        writerAclFixtures = @($writerAclFixtures)
        modulesRoot = $modulesRoot; moduleMarkers = $moduleMarkers
        pythonExecutable = $pythonExecutable
        cliSmokeIsolation = @{ ephemeral = $true; accountName = $accountName; accountSid = $accountSid; nodeExecutable = @(Get-Command node.exe -CommandType Application -ErrorAction Stop)[0].Source }
        sshClient = $sshClient; nativeClientConfig = $nativeClientConfig
        serverLog = $serverLog
        adminConfigPath = $adminConfigPath; adminHelper = $adminInstalled.helper
        adminFileRoot = $adminInstalled.fileRoot; adminStageRoot = $adminInstalled.stageRoot
    } | ConvertTo-Json -Compress -Depth 6)
    Set-FixtureAcl $fixturePath ''
    $env:AGS_WINDOWS_SSH_FIXTURE = $fixturePath
    if ($env:AGS_WINDOWS_CLI_PACKAGE_SMOKE -eq '1') {
        Write-Output '공식 CLI 설치 전용 시험: 일반 SSH/Python 회귀는 별도 기본 실행에서 확인합니다.'
        & node --test (Join-Path $PSScriptRoot 'windows-agent-cli-smoke.test.mjs')
        Assert-Exit '공식 CLI 설치 전용 시험'
    } else {
        Write-Output '기본 Windows SSH/Python 회귀 시험: 공식 CLI 설치 전용 시험은 선택하지 않았습니다.'
        & node --test --test-concurrency=1 (Join-Path $PSScriptRoot 'windows-ssh-integration.test.mjs') (Join-Path $PSScriptRoot 'windows-python-source.test.mjs')
        Assert-Exit '실제 Windows SSH/Python 회귀 시험'
    }
    $testsPassed = $true
    if ($env:AGS_WINDOWS_CLI_PACKAGE_SMOKE -eq '1') { Write-Output '공식 CLI 설치 전용 시험 통과' }
    else { Write-Output '실제 Windows OpenSSH/Python 회귀 시험 통과' }
} finally {
    Remove-Item Env:AGS_WINDOWS_SSH_FIXTURE -ErrorAction SilentlyContinue
    Remove-Item Env:SOLID_PYTHON -ErrorAction SilentlyContinue
    if ($registeredTask) {
        # 살아 있는 부모를 먼저 종료하면 자식 트리를 놓친다. 루트가 살아 있을 때 트리를 정리한다.
        Get-CimInstance Win32_Process -Filter "Name = 'sshd.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($fixtureRoot)
        } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Continue
        # SSH가 분리한 하위 프로세스도 이 시험 전용 계정 소유일 때만 종료한다.
        $fixtureNames = @($accountName, $adminName)
        foreach ($process in (Get-CimInstance Win32_Process)) {
            if ($process.Name -notin @('sshd.exe', 'sshd-session.exe', 'powershell.exe', 'pwsh.exe', 'python.exe', 'node.exe', 'cmd.exe', 'sftp-server.exe')) { continue }
            try {
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
            } catch [Microsoft.Management.Infrastructure.CimException] {
                if ($_.Exception.NativeErrorCode -eq [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) {
                    Write-Output '격리 계정 정리: 이미 종료된 프로세스 스냅샷을 건너뜁니다.'
                    continue
                }
                $cleanupErrors.Add(('프로세스 소유자 조회 실패: ' + $_.Exception.StatusCode))
                Write-Output $cleanupErrors[$cleanupErrors.Count - 1]
                continue
            }
            if ($owner.ReturnValue -eq 0 -and $owner.User -in $fixtureNames) {
                & taskkill.exe /PID $process.ProcessId /T /F 2>$null | Out-Null
            }
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Continue
    }
    if (-not $testsPassed) {
        # 서버 종료 뒤에도 공유 읽기를 사용한다. 비밀키·암호는 로그에 기록되지 않는다.
        Write-ServerLogTail
    }
    if ($createdUser) { Remove-LocalUser -Name $accountName -ErrorAction Continue }
    if ($createdAdmin) { Remove-LocalUser -Name $adminName -ErrorAction Continue }
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
    if ($testsPassed -and $cleanupErrors.Count -gt 0) { throw '격리 시험 정리에서 프로세스 소유자 조회 오류가 발생했습니다.' }
}
