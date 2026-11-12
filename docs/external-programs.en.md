# External programs

[한국어](external-programs.ko.md) · [README](../README.md)

Version 3.0.0 is implemented in Java 25 and Spring Boot. As a rule, work that Java can do is done in Java and is not delegated to an external program. This document lists the external programs that remain, and states for each one where it runs and why Java cannot replace it. A program that is not listed here is not used. The Java classes that start or send these programs carry the same reason in their class documentation.

The list follows the migration decisions on external programs and on installation, the feature map (items Q9, Q10 and Q12) and the stage 3 design (sections 2.3, 2.4, 6.2 and 7.3) in `java/docs/migration/`. Programs and classes marked "planned" belong to a later migration stage and do not exist in the source yet.

## What is not an external program

The following work is done in Java and uses no helper program: file transfer and atomic replacement on targets (SFTP through Apache MINA SSHD, nothing is installed on the target), command supervision (SSH exec channels), RFB and PNG handling, session management, the environment editor, the installation and upgrade logic, and the client command line.

## Local programs (the portal host)

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| `xfreerdp3` (FreeRDP client with the X11 input patch) | The portal host, Linux only, as the relay of an RDP desktop session. | The JDK has no RDP client. The release does not implement the RDP client protocol (credential delegation, graphics and channels) in Java, and the input patch is native C code against FreeRDP. The Windows server edition reports the desktop capability as unsupported. | `portal-desktop`, class `process.LocalDesktopProcess` (planned, stage 5). The classes of `portal-desktop` that start the local programs are added to the ArchUnit allow list of rule A-PROCESS (`PortalRules.PROCESS_ALLOWED`), each with this reason. |
| `Xvnc` (X server with a VNC front end) | The portal host (relay backend) and the remote Linux target (VNC backend, see the remote table), Linux only. | An X server is a native program and the JDK has no X server API. | The same as above for the local case; `portal-desktop`, `session.LinuxDesktopSession` (planned, stage 5). |
| `openbox`, `xterm`, `xdpyinfo`, `xwininfo`, `xprop` | Inside the managed X display started with `Xvnc`: the window manager, the application the product opens, and read-only queries of the X11 state. | They are X11 programs, and the JDK has no standard X11 client API for window management or for querying the display. | `portal-desktop`, `session.LinuxDesktopSession` (planned, stage 5). |

Only the classes named above may start an operating system process: ArchUnit rule A-PROCESS fails the build for any other class, and rule A-NO-LOCAL-PROCESS forbids `ProcessBuilder` and `Runtime.exec` in the whole `portal-ssh` module.

## Programs on the remote target

The portal does not run these programs. It sends them to the target through an SSH channel, and the target runs them. The target has no JVM, and executing the approved command on the target is the function of the product.

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| The command of the user, and the Python source of a `source` request (`/usr/bin/python3 -I -B -S -X utf8`) | The remote target, after approval. | Running the command that the user approved on the target is the product function. The command and the interpreter belong to the target system, not to the portal. | `portal-ssh`, `exec` (`MinaRemoteExecutor`); `platform.LinuxTargetPlatform` and `platform.WindowsTargetPlatform` (class documentation); the fixed receiver text under `src/main/resources/ssh/remote/**`. |
| The PowerShell wrapper of a Windows target (`powershell` with an encoded command, CLIXML suppression, the 8000 character limit of the Windows command line) | The remote Windows target, whose default shell is `cmd.exe`. | The wrapper is data that is sent to the interpreter of the target. The target interprets it, and Java only builds and sends the text. | `portal-ssh`, `platform.WindowsCommandWrapper` (stage 3); the resource files `src/main/resources/ssh/remote/*.ps1`. The test that fixes their hash is part of stage 3. |
| Fixed target commands of the agent CLI installer: `tar` (unpack the verified package), `ln -sfn` or a rename (switch the `current` link), the version query of the installed CLI (read only, never run from an untrusted path), `test -x` (find `sftp-server`) | The remote target. | The target has no JVM, and the tools that unpack an archive and switch a link on the target are the tools of the target. The package is downloaded, checked (sha512) and uploaded by Java; only these few commands are run remotely. | `portal-ssh`, `cli.AgentCliInstaller` and the constant resource of `AgentCliPlan` (stage 3). Test S3-AG-10 compares the commands that were sent with this list. |
| `sudo -n` (the elevate request: `sudo -n <sftp-server>` over an exec channel, or the fixed fallback commands `cat`, `tee`, `mv` run through `sudo -n`) | The remote Linux target. | Privilege elevation on the target is done by the operating system of the target. | `portal-ssh`, `sftp` (stage 3, the elevation plan chooses the way). |
| Read-only checks on the target: the administrator check of a Windows target, the start of `Xvnc` and its helper programs on a remote Linux target | The remote target. | They are commands of the target system. | `portal-ssh` (`platform`, stage 3); the remote Linux desktop launcher in `portal-desktop` (planned, stage 5). |

The fixed command lists are kept in the code as resources and are the same as the lists in this section. Text that is sent to a model or a target is fixed and never built from user input.

## Installation, build and continuous integration

| Program | Where it runs | Why Java cannot replace it | Code location |
| --- | --- | --- | --- |
| Install scripts: `install.sh` (Linux, in the `.tar.gz` bundle) and `install.cmd` (Windows, in the `.zip` bundle) | The machine that installs the server or the PC client, once per install, upgrade or removal. | The script finds the bundled Java runtime and calls the Java install command (`java -jar ... install`, `upgrade`, `uninstall`). The script is needed because no Java runs yet when the install starts, and because the registration of an operating system service (`systemctl` on Linux, a service wrapper on Windows) and of the operating system accounts (`useradd`, `apt-get`, enabling sshd, validating a sudoers file with `visudo -c`) has no JDK API. Everything else is Java: the settings, the directories and permissions, the hook registration, the migration from 2.x, and the content of the sudoers file. | `packaging/` (planned, stage 7). |
| CI preparation scripts: `java/ci/openssh-linux.sh` and `java/ci/openssh-windows.cmd` | A one-shot GitHub runner, before the Gradle task `:portal-ssh:realOpenSshTest`. | They create a temporary operating system account, a sudoers rule and a second `sshd` (on Windows: the OpenSSH Server capability and `sshd` as SYSTEM in a scheduled task). The JDK has no API for operating system accounts, services or `sshd`. The tests that use the server are Java. | `java/ci/` and `.github/workflows/java-openssh.yml` (stage 3). |
| Gradle wrapper: `gradlew` and `gradlew.bat` | The development machine and the CI runner. | The wrapper downloads and starts Gradle, so it runs before any Java build tool exists. | `java/gradlew`, `java/gradlew.bat`. The CI commands call `./gradlew`. |
| Build of the patched FreeRDP client: `git apply`, `cmake`, `ninja` and the C compiler for the protocol test `test_agni.c` | A builder container at build time, never in the product runtime. | The patched client is C code. A Gradle task written in Java downloads the fixed source archive, checks its SHA-256 and writes the manifest; the patch is the committed file `freerdp-input.patch`. | `native/freerdp-input/` (the existing builder `Dockerfile` and the committed patch) and a Gradle task (planned, stage 7). |

## Where this is checked

- ArchUnit rule A-PROCESS limits `ProcessBuilder` and `Runtime.exec` to the classes on the allow list; rule A-NO-LOCAL-PROCESS keeps `portal-ssh` off that list for good.
- Test S3-AG-10 compares the commands that the agent CLI installer sends with the list in this document.
- A program is added to this document in the same change that adds the code that starts it, together with the reason why Java cannot replace it.
