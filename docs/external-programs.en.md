# External programs

[한국어](external-programs.ko.md) · [README](../README.md)

Version 3.0.0 is implemented in Java 25 and Spring Boot. As a rule, work that Java can do is done in Java and is not delegated to an external program. This document lists the external programs that remain, and states for each one where it runs and why Java cannot replace it. A program that is not listed here is not used. The Java classes that start or send these programs carry the same reason in their class documentation.

The list follows the migration decisions on external programs and on installation, the feature map (items Q9, Q10 and Q12) and the stage 3 design (sections 2.3, 2.4, 6.2 and 7.3) in `java/docs/migration/`. Programs and classes marked "planned" belong to a later migration stage and do not exist in the source yet.

## What is not an external program

The following work is done in Java and uses no helper program: file transfer and atomic replacement on targets (SFTP through Apache MINA SSHD, nothing is installed on the target; the elevated transfer on a POSIX target is the exception that is listed below), command supervision (SSH exec channels), RFB and PNG handling, session management, the environment editor, the installation and upgrade logic, and the client command line.

## Local programs (the portal host)

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| `xfreerdp3` (FreeRDP client with the X11 input patch) | The portal host, Linux only, as the relay of an RDP desktop session. | The JDK has no RDP client. The release does not implement the RDP client protocol (credential delegation, graphics and channels) in Java, and the input patch is native C code against FreeRDP. The Windows server edition reports the desktop capability as unsupported. | `portal-desktop`, class `process.LocalDesktopProcess` (planned, stage 5). The classes of `portal-desktop` that start the local programs are added to the ArchUnit allow list of rule A-PROCESS (`PortalRules.PROCESS_ALLOWED`), each with this reason. |
| `Xvnc` (X server with a VNC front end) | The portal host (relay backend) and the remote Linux target (VNC backend, see the remote table), Linux only. | An X server is a native program and the JDK has no X server API. | The same as above for the local case; `portal-desktop`, `session.LinuxDesktopSession` (planned, stage 5). |
| `openbox`, `xterm`, `xdpyinfo`, `xwininfo`, `xprop` | Inside the managed X display started with `Xvnc`: the window manager, the application the product opens, and read-only queries of the X11 state. | They are X11 programs, and the JDK has no standard X11 client API for window management or for querying the display. | `portal-desktop`, `session.LinuxDesktopSession` (planned, stage 5). |

Only the classes named above may start an operating system process: ArchUnit rule A-PROCESS fails the build for any other class, and rule A-NO-LOCAL-PROCESS forbids `ProcessBuilder` and `Runtime.exec` in the whole `portal-ssh` module.

## Programs and fixed commands on the remote target

The portal does not run these programs. It sends them to the target through an SSH channel, and the target runs them. The target has no JVM, and executing the approved command on the target is the function of the product: a Java class on the portal host can only build and send the text. For this reason none of the programs in this section can be replaced by Java, and none of them is started on the portal host.

Every command in this section other than the command and the source that the user submitted is fixed text. The only values that are put into a fixed command are validated ones (a path, a digest, a size, a permission mode, or the parts of an agent CLI release), each quoted for the shell of the target. A fixed command never contains free text of a caller.

### Execution of approved requests

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| The command of the user, and the Python source of a `source` request: `/usr/bin/python3 -I -B -S -X utf8 -c <receiver>` on a POSIX target, and the `python.exe` that the administrator configured for the target on a Windows target, started by a PowerShell launcher | The remote target, after approval. | Running the command that the user approved on the target is the product function. The command and the interpreter belong to the target system, not to the portal. The receiver is a Python text that is sent with the request: it reads the standard input to its end, checks the length and the SHA-256, and compiles; a source that was cut off or changed is refused with exit code 125 before it has any effect (exit code 126 when it is not UTF-8 or does not compile). It is a check of the transport and not a sandbox. | `portal-ssh`, `exec` (`MinaRemoteExecutor`); `platform.LinuxTargetPlatform`, `platform.WindowsTargetPlatform` and `platform.PythonSourceReceiver`; the receiver texts `python-receiver-posix.py` and `python-receiver-windows.py` and the launcher texts `windows-source-launcher.ps1` and `windows-source-bootstrap.ps1` under `src/main/resources/ssh/remote/`. |
| The PowerShell wrapper of a Windows target: `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ... -EncodedCommand <base64>` (error report, progress records and CLIXML suppression, the 8000 character limit of the Windows command line) | The remote Windows target, whose default shell is `cmd.exe`. | The wrapper is data that is sent to the interpreter of the target. The target interprets it, and Java only builds and sends the text. | `portal-ssh`, `platform.WindowsCommandWrapper`; the resource files `src/main/resources/ssh/remote/*.ps1`. Test S3-TP-04 (`RemoteScriptsTest`) fixes the SHA-256 of the twelve resource files. |
| The check of an administrator connection of a Windows target: a read-only PowerShell query of the Windows identity (`WindowsPrincipal.IsInRole(Administrator)`), sent through the wrapper above; it ends with exit code 0 when the connection is the administrator's | The remote Windows target, before elevated file work. | The membership of the token of the connection in the administrators group is known only to the operating system of the target. | `portal-ssh`, `platform.WindowsTargetPlatform` (the elevation plan) and `sftp.ElevationProbe`. |
| The start of `Xvnc` and its helper programs on a remote Linux target | The remote Linux target. | They are commands of the target system. | The remote Linux desktop launcher in `portal-desktop` (planned, stage 5). |

### Fixed commands of the elevation fallback (POSIX targets)

Elevated file work on a POSIX target is done by the commands below (class `sftp.ElevatedExecTransfer`; the probe is run by `sftp.ElevationProbe`). The other way, an SFTP server that is started with `sudo -n` over an exec channel, is added only if the test on a real server (S3-RO-02) shows that it works. Every command runs behind `sudo -n`, which never asks for a password; when the probe `sudo -n true` fails, the file work is refused before anything is written. Limits of this path: a file is at most the transfer limit (64 MiB), the whole file is held in memory while it is sent, and the owner and group of a replaced file are not preserved (the new file belongs to the elevated account). Each command is a program of the operating system of the target, run there as the elevated account; the target has no JVM, so Java cannot stand in for any of them.

| Command | Use | Why Java cannot replace it |
| --- | --- | --- |
| `sudo -n` | The prefix of every command below; `sudo -n true` is the probe. | Elevation is performed by the operating system of the target, for the account that sudo names; the portal host can only ask for it. |
| `sh` | Runs the body of a fixed command (`umask 077`, `set -C`, the type checks, the digest check followed by the placement) as one command. | The checks and the placement must run together on the target, so that a lost connection cannot leave a step unchecked, and the shell is the only interpreter that is known to be there. |
| `cat` | Writes the standard input into a new temporary file next to the destination (the file must not exist; mode 0600), and writes a file to the standard output for a download. | Only a process of the target that runs as the elevated account can create or read the file. |
| `mv` | Puts the checked temporary file in place (`mv -f`). | The replacement is a rename in the file system of the target, made as the elevated account. |
| `ln` | Puts the checked temporary file in place where the destination must not be replaced (it fails when the destination exists). | A link is made by the file system of the target, as the elevated account. |
| `rm` | Removes the temporary file after a refusal or after the link was made. | The temporary file belongs to the elevated account on the target. |
| `sha256sum`, `cut` | `sha256sum` computes the digest of the temporary file; `cut` takes its first field. | The digest must be computed where the file is, by an account that may read it. |
| `wc` | Counts the bytes of the temporary file and of a file that is to be downloaded (`wc -c`). | The size must be read where the file is, by an account that may read it. |
| `stat` | Reads the permission bits back after `chmod` (`stat -c %a`). | The bits are read from the file system of the target. |
| `chmod` | Sets the permission bits. | The bits are set in the file system of the target, as the elevated account. |

### Fixed commands of the agent CLI installer

The installer checks the package in Java (SHA-512, against the release that the owner approved), uploads it over SFTP, and then runs the commands of its plan, one for each step (`AgentCliPlan`, made by `LinuxTargetPlatform.agentCliPlan` and `WindowsTargetPlatform.agentCliPlan`). Nothing that was installed is run: the version is read from the metadata file `package.json`. The package is unpacked under the home directory of the login account. The command of a step differs from the command of every other step, and test S3-AG-10 (`AgentCliPlansTest`) fixes this. The target has no JVM, so Java cannot stand in for any of these programs.

| Command | Where it runs and use | Why Java cannot replace it |
| --- | --- | --- |
| `printf`, `readlink` | A POSIX target. `printf` prints the fixed paths of the release; `readlink` reads the `current` link before and after the switch. | The link is read in the file system of the target. |
| `mkdir` | A POSIX target. Creates the partial directory of the release. | The directory is made in the file system of the target. |
| `tar` | A POSIX target. Unpacks the verified package (`tar -xzf`). | The archive is unpacked where the files are to be, and the unpacking tool is the target's. |
| `grep`, `head`, `sed` | A POSIX target. Read the first `version` field of `package.json` (the file may be written on many lines or on one). | The file is on the target; reading it by command avoids running an installed program. |
| `cp`, `ln`, `mv`, `rm` | A POSIX target. `cp -P` keeps the previous `current` link; `ln -sfn` and `mv -Tf` switch the `current` link (a new link is made, then renamed over the old one); `mv` also puts the unpacked directory in place; `rm` removes the package, the previous link and the partial directory. | The switch is a rename in the file system of the target. |
| `powershell.exe` with an encoded command | A Windows target. Runs every step of the plan: `New-Item` (directories and the `current` junction), `Set-Location`, `Move-Item`, `Remove-Item`, `Get-Item`, `Test-Path`, `Join-Path`, `Get-Content`, `Set-Content` and `ConvertFrom-Json` (the version). | The default shell of the target is `cmd.exe`, and these operations are performed by the PowerShell of the target. |
| `tar.exe` | A Windows target (Windows 10 version 1803 and later; the target's own program). Unpacks the verified package. | The archive is unpacked by the tool of the target, where the files are to be. |

On a Windows target the `current` junction is removed and made again, so the switch is not atomic. The installer reads it back before it reports the installation as done. This has not been checked against a real Windows server yet (test S3-RW).

The fixed commands are kept in the code (`LinuxTargetPlatform`, `WindowsTargetPlatform`, `ElevatedExecTransfer`, `ElevationProbe`) and the fixed sentences as resources under `src/main/resources/ssh/remote/`. Text that is sent to a model or a target is fixed and never built from user input, except the command and the source that the user submitted and the owner approved.

## Installation, build and continuous integration

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| Install scripts: `install.sh` (Linux, in the `.tar.gz` bundle) and `install.cmd` (Windows, in the `.zip` bundle) | The machine that installs the server or the PC client, once per install, upgrade or removal. | The script finds the bundled Java runtime and calls the Java install command (`java -jar ... install`, `upgrade`, `uninstall`). The script is needed because no Java runs yet when the install starts, and because the registration of an operating system service (`systemctl` on Linux, a service wrapper on Windows) and of the operating system accounts (`useradd`, `apt-get`, enabling sshd, validating a sudoers file with `visudo -c`) has no JDK API. Everything else is Java: the settings, the directories and permissions, the hook registration, the migration from 2.x, and the content of the sudoers file. | `packaging/` (planned, stage 7). |
| CI preparation scripts: `java/ci/openssh-linux.sh` and `java/ci/openssh-windows.cmd` | A one-shot GitHub runner, before the Gradle task `:portal-ssh:realOpenSshTest`. | They create a temporary operating system account, a sudoers rule and a second `sshd` (on Windows: the OpenSSH Server capability and `sshd` as SYSTEM in a scheduled task). The JDK has no API for operating system accounts, services or `sshd`. The tests that use the server are Java. | `java/ci/` and `.github/workflows/java-openssh.yml` (stage 3). |
| Gradle wrapper: `gradlew` and `gradlew.bat` | The development machine and the CI runner. | The wrapper downloads and starts Gradle, so it runs before any Java build tool exists. | `java/gradlew`, `java/gradlew.bat`. The CI commands call `./gradlew`. |
| Build of the patched FreeRDP client: `git apply`, `cmake`, `ninja` and the C compiler for the protocol test `test_agni.c` | A builder container at build time, never in the product runtime. | The patched client is C code. A Gradle task written in Java downloads the fixed source archive, checks its SHA-256 and writes the manifest; the patch is the committed file `freerdp-input.patch`. | `native/freerdp-input/` (the existing builder `Dockerfile` and the committed patch) and a Gradle task (planned, stage 7). |

## Where this is checked

- ArchUnit rule A-PROCESS limits `ProcessBuilder` and `Runtime.exec` to the classes on the allow list; rule A-NO-LOCAL-PROCESS keeps `portal-ssh` off that list for good.
- Test S3-AG-10 (`AgentCliPlansTest`) fixes the commands of the agent CLI plan of each platform: one command for every step, made of validated release parts only, and no step runs an installed program. Test S3-TP-04 (`RemoteScriptsTest`) fixes the SHA-256 of the fixed sentences under `src/main/resources/ssh/remote/`.
- A program is added to this document in the same change that adds the code that starts it, together with the reason why Java cannot replace it.
