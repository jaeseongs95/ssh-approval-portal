@echo off
rem Prepares a real Windows OpenSSH server on a one-shot GitHub Windows runner for the Gradle task :portal-ssh:realOpenSshTest
rem (stage 3 design 7.3, decision D3-11). Modelled on the 2.x test/windows-ssh-ci.ps1.
rem
rem Why this is a cmd script and not Java: creating a local Windows account, installing the OpenSSH Server feature and running sshd as SYSTEM (a scheduled task) are
rem operating system administration. The JDK has no API for any of them, and the product has no business doing them, so the job that prepares the test environment does
rem it (the same category as the install scripts that register an OS service; see docs/external-programs.en.md). The few PowerShell calls below are single lines
rem because Windows offers account, feature and task management only through PowerShell cmdlets. The tests that talk to the server are Java (JUnit, Apache MINA SSHD).
rem
rem What it does, as the runner administrator:
rem   1. installs the OpenSSH Server capability when sshd.exe is missing;
rem   2. creates a throw-away non-administrator account (portalci + a number) with a random password that no line of this script or of the log contains;
rem   3. generates an ed25519 client key pair (in %RUNNER_TEMP%\portal-openssh-ci, with known_hosts) and an ed25519 host key (in %ProgramData%\portal-openssh-ci, readable
rem      by SYSTEM and Administrators only, as sshd requires; the account must also be able to reach authorized_keys, which is why the server side is not in the runner temp);
rem   4. writes an sshd_config for a random loopback port and starts that sshd as SYSTEM in a scheduled task; the system sshd service is not touched;
rem   5. writes known_hosts with the host public key only, so that host key checking stays on in the tests;
rem   6. appends the connection values (no secret: the key is named by its path) to %GITHUB_ENV% for the next workflow step:
rem      PORTAL_OPENSSH_PORT, PORTAL_OPENSSH_USER, PORTAL_OPENSSH_KEY_FILE, PORTAL_OPENSSH_KNOWN_HOSTS
rem
rem Usage: openssh-windows.cmd          prepare (default)
rem        openssh-windows.cmd stop     stop sshd and remove the task and the account (the workflow calls it with if: always())
rem It refuses to run outside a GitHub Windows runner: it creates an account and a SYSTEM task, which nobody wants on a development machine.
setlocal EnableExtensions DisableDelayedExpansion

if /i not "%GITHUB_ACTIONS%"=="true" goto :notrunner
if /i not "%RUNNER_OS%"=="Windows" goto :notrunner
if "%RUNNER_TEMP%"=="" goto :notrunner
net session >nul 2>&1
if errorlevel 1 (
    echo This script needs the runner administrator.>&2
    exit /b 1
)

set "CLIENT=%RUNNER_TEMP%\portal-openssh-ci"
set "SRV=%ProgramData%\portal-openssh-ci"
set "OPENSSH=%SystemRoot%\System32\OpenSSH"
set "SSHD=%OPENSSH%\sshd.exe"
set "KEYGEN=%OPENSSH%\ssh-keygen.exe"
set "SSHCLIENT=%OPENSSH%\ssh.exe"
set "TASK=PortalOpenSshCi"

if /i "%~1"=="stop" goto :stop

rem 1. The OpenSSH Server capability (the GitHub image may not have it). A restart request cannot be honoured on a runner, so it fails the script.
if not exist "%SSHD%" powershell -NoProfile -NonInteractive -Command "$c = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'; if ($c.RestartNeeded) { exit 3 }"
if errorlevel 1 (
    echo Installing the OpenSSH Server capability failed or needs a restart.>&2
    exit /b 1
)
if not exist "%SSHD%" goto :nosshd
if not exist "%KEYGEN%" goto :nosshd
if not exist "%SSHCLIENT%" goto :nosshd
if not exist "%OPENSSH%\sftp-server.exe" goto :nosshd

mkdir "%CLIENT%" "%SRV%" >nul 2>&1
rem The server side directory must be readable by the account (authorized_keys); every secret file in it gets its own ACL below.

rem 2. The account. The random password is made and used inside one PowerShell process: it is never an argument of net.exe and never printed.
set "CI_USER=portalci%RANDOM%"
powershell -NoProfile -NonInteractive -Command "$p = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force; New-LocalUser -Name '%CI_USER%' -Password $p -AccountNeverExpires -PasswordNeverExpires | Out-Null; Add-LocalGroupMember -SID S-1-5-32-545 -Member '%CI_USER%'"
if errorlevel 1 (
    echo Creating the test account failed.>&2
    exit /b 1
)
> "%CLIENT%\user" echo %CI_USER%
rem sshd runs as SYSTEM with StrictModes on: the server side directory is owned and written by SYSTEM and Administrators only; the account may read and traverse it.
icacls "%SRV%" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)(F) *S-1-5-32-544:(OI)(CI)(F) "%CI_USER%:(OI)(CI)(RX)" >nul
if errorlevel 1 goto :keyfail

rem 3. Keys. The host key is readable by SYSTEM and Administrators only (S-1-5-18, S-1-5-32-544), owned by Administrators.
"%KEYGEN%" -q -t ed25519 -N "" -f "%CLIENT%\client_key"
if errorlevel 1 goto :keyfail
"%KEYGEN%" -q -t ed25519 -N "" -f "%SRV%\host_key"
if errorlevel 1 goto :keyfail
rem Win32-OpenSSH refuses a host key whose owner is not SYSTEM or Administrators, or whose ACL names any other account (Repair-SshdHostKeyPermission and
rem Repair-FilePermission of OpenSSHUtils.psm1, FixHostFilePermissions.ps1: owners SYSTEM and Administrators, access for those two only). ssh-keygen leaves an explicit entry
rem for the account that ran it (the runner administrator), which "/inheritance:r /grant:r" alone does not remove: the ACL is reset first, then inheritance is cut, then
rem only SYSTEM and Administrators are granted, then the owner is set. See :secure.
call :secure "%SRV%\host_key"
if errorlevel 1 goto :keyfail
copy /y "%CLIENT%\client_key.pub" "%SRV%\authorized_keys" >nul
if errorlevel 1 goto :keyfail
rem authorized_keys of the test account: owned by Administrators, SYSTEM and Administrators full control, and the account itself may read it (Repair-AuthorizedKeyPermission
rem allows the user's own entry; the file is not in the profile folder, so StrictModes only needs the owner and the entries to be trusted ones).
call :secure "%SRV%\authorized_keys"
if errorlevel 1 goto :keyfail
icacls "%SRV%\authorized_keys" /grant "%CI_USER%:(R)" >nul
if errorlevel 1 goto :keyfail

rem 4. A random loopback port that nothing listens on (bound to port 0 and released again).
set "PORT="
for /f %%p in ('powershell -NoProfile -NonInteractive -Command "$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $l.LocalEndpoint.Port; $l.Stop()"') do set "PORT=%%p"
if "%PORT%"=="" (
    echo No free loopback port found.>&2
    exit /b 1
)

rem 5. sshd_config. Paths use forward slashes, as sshd_config does on Windows. StrictModes stays on; AllowUsers names the test account only.
set "HOSTKEY_F=%SRV%\host_key"
set "HOSTKEY_F=%HOSTKEY_F:\=/%"
set "AUTH_F=%SRV%\authorized_keys"
set "AUTH_F=%AUTH_F:\=/%"
set "SFTP_F=%OPENSSH%\sftp-server.exe"
set "SFTP_F=%SFTP_F:\=/%"
> "%SRV%\sshd_config" echo Port %PORT%
>> "%SRV%\sshd_config" echo ListenAddress 127.0.0.1
>> "%SRV%\sshd_config" echo HostKey %HOSTKEY_F%
>> "%SRV%\sshd_config" echo AuthorizedKeysFile %AUTH_F%
>> "%SRV%\sshd_config" echo PubkeyAuthentication yes
>> "%SRV%\sshd_config" echo PasswordAuthentication no
>> "%SRV%\sshd_config" echo KbdInteractiveAuthentication no
>> "%SRV%\sshd_config" echo AuthenticationMethods publickey
>> "%SRV%\sshd_config" echo PermitEmptyPasswords no
>> "%SRV%\sshd_config" echo AllowUsers %CI_USER%
>> "%SRV%\sshd_config" echo StrictModes yes
>> "%SRV%\sshd_config" echo LogLevel VERBOSE
>> "%SRV%\sshd_config" echo Subsystem sftp %SFTP_F%
rem sshd_config is checked like the host key (Repair-SshdConfigPermission: owners SYSTEM and Administrators, full access for SYSTEM): the directory's entry for the account
rem must not reach it.
call :secure "%SRV%\sshd_config"
if errorlevel 1 goto :keyfail
"%SSHD%" -t -f "%SRV%\sshd_config"
if errorlevel 1 (
    echo The sshd configuration is not valid.>&2
    exit /b 1
)

rem 6. known_hosts: the two fields of the host public key (without its comment), for exactly this host and port. Forward slashes for the ssh client options.
type nul > "%CLIENT%\known_hosts"
for /f "tokens=1,2" %%a in (%SRV%\host_key.pub) do >> "%CLIENT%\known_hosts" echo [127.0.0.1]:%PORT% %%a %%b
set "KEY_F=%CLIENT%\client_key"
set "KEY_F=%KEY_F:\=/%"
set "KNOWN_F=%CLIENT%\known_hosts"
set "KNOWN_F=%KNOWN_F:\=/%"

rem 7. sshd needs SYSTEM, so it runs in a scheduled task (as in the 2.x script); the paths contain no space, so no quoting is needed in the argument.
powershell -NoProfile -NonInteractive -Command "$a = New-ScheduledTaskAction -Execute '%SSHD%' -Argument '-D -f %SRV%\sshd_config -E %SRV%\sshd.log'; $p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest; $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 45); Register-ScheduledTask -TaskName '%TASK%' -Action $a -Principal $p -Settings $s | Out-Null; Start-ScheduledTask -TaskName '%TASK%'"
if errorlevel 1 (
    echo Starting sshd as a scheduled task failed.>&2
    exit /b 1
)

rem 8. Wait until a login with the key works. (ping is the sleep: timeout.exe refuses to run when the input is redirected, as it is in a workflow step.)
set /a TRY=0
:wait
"%SSHCLIENT%" -p %PORT% -i "%KEY_F%" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=%KNOWN_F%" %CI_USER%@127.0.0.1 exit >nul 2>&1
if not errorlevel 1 goto :ready
set /a TRY+=1
if %TRY% GEQ 60 goto :notready
ping -n 2 127.0.0.1 >nul
goto :wait

:ready
>> "%GITHUB_ENV%" echo PORTAL_OPENSSH_PORT=%PORT%
>> "%GITHUB_ENV%" echo PORTAL_OPENSSH_USER=%CI_USER%
>> "%GITHUB_ENV%" echo PORTAL_OPENSSH_KEY_FILE=%KEY_F%
>> "%GITHUB_ENV%" echo PORTAL_OPENSSH_KNOWN_HOSTS=%KNOWN_F%
echo Real Windows OpenSSH server ready on 127.0.0.1:%PORT% for account %CI_USER%.
exit /b 0

:notready
echo The prepared sshd does not accept the test account (port %PORT%). Last lines of its log:>&2
if exist "%SRV%\sshd.log" powershell -NoProfile -NonInteractive -Command "Get-Content -LiteralPath '%SRV%\sshd.log' -Tail 20"
echo The ACLs of the server files (no secret in them):>&2
icacls "%SRV%\host_key" "%SRV%\sshd_config" "%SRV%\authorized_keys" >&2
exit /b 1

:stop
rem Best effort: the runner is thrown away anyway, so a failure here must not hide the result of the tests.
powershell -NoProfile -NonInteractive -Command "Stop-ScheduledTask -TaskName '%TASK%' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '%TASK%' -Confirm:$false -ErrorAction SilentlyContinue"
if not exist "%CLIENT%\user" exit /b 0
set /p CI_USER=<"%CLIENT%\user"
powershell -NoProfile -NonInteractive -Command "Remove-LocalUser -Name '%CI_USER%' -ErrorAction SilentlyContinue"
exit /b 0

:secure
rem Makes the file what Win32-OpenSSH's StrictModes wants of a server file: no inherited entry, no explicit entry of the account that created it, full control for SYSTEM
rem (S-1-5-18) and the Administrators group (S-1-5-32-544) only, owned by Administrators. Sources:
rem   https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/openssh/OpenSSHUtils.psm1  (Repair-SshdHostKeyPermission, Repair-FilePermission)
rem   https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/openssh/FixHostFilePermissions.ps1
rem   https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement  (server files and their permissions)
icacls "%~1" /reset >nul
if errorlevel 1 exit /b 1
icacls "%~1" /inheritance:r >nul
if errorlevel 1 exit /b 1
icacls "%~1" /grant:r *S-1-5-18:(F) *S-1-5-32-544:(F) >nul
if errorlevel 1 exit /b 1
icacls "%~1" /setowner *S-1-5-32-544 >nul
if errorlevel 1 exit /b 1
exit /b 0

:keyfail
echo Preparing the keys failed.>&2
exit /b 1

:nosshd
echo The Windows OpenSSH executables (sshd, ssh-keygen, ssh, sftp-server) are not present.>&2
exit /b 1

:notrunner
echo openssh-windows.cmd runs only on a one-shot GitHub Windows runner.>&2
exit /b 1
