# 3.0.0 Java 전환 설계 전제의 공식 문서 대조 (SSH·배포·호스트 hook)

조사일 2026-11-12. 근거는 웹 공식 문서뿐이다(블로그·Stack Overflow·기억 제외). 코드 실행 없음. 원문은 영문 그대로 인용한다.
표기: 「공식 저장소」는 공식 문서가 없어 공식 저장소의 README·Javadoc·소스를 근거로 쓴 것이다. 「미확인」은 확인한 범위 안에서 공식 근거를 찾지 못한 것이다.
조사 도구 한계: WebFetch는 페이지를 요약 모델로 처리한다. 인용은 도구가 돌려준 원문이며, 긴 페이지(Claude hooks 29만 자)는 일부만 읽었다. 읽은 범위는 각 항목에 적었다.

## 0. 요약: 계획 전제와 어긋나는 것

| # | 계획 문장 | 공식 근거가 말하는 것 | 영향 |
|---|---|---|---|
| A | 「`portal-ssh` sshd-core, sshd-sftp」 | 최신 안정판은 2.20.1이다. Maven 메타데이터의 `<latest>`는 3.0.0-M7(마일스톤)이다. 안정판 번호를 2.20.1로 고정해야 한다 | 판 고정(Q1) |
| B | 「MINA SSHD exec·SFTP를 Windows OpenSSH와 Linux에 쓸 수 있는가」 | MINA 공식 문서에 Windows OpenSSH와의 호환 언급이 없다(미확인). 1단계 시범 (c)는 실측만이 근거다 | 1단계 시범 필수(Q1) |
| C | 「SFTP 업로드 후 원자적 교체」(D-0035) | MINA 문서는 SFTP v3~6 협상, `posix-rename@openssh.com`은 클라이언트 쪽 지원이라고 적는다. OpenSSH(Windows 포크 포함) sftp-server 소스는 `posix-rename@openssh.com`을 광고·처리하지만, 일반 rename은 대상이 있으면 `SSH2_FX_FAILURE`다. 대상이 있을 때의 교체는 posix-rename 확장에 의존해야 한다 | 설계 선택(Q1·Q2) |
| D | 「SFTP … 권한 오류 구분」「업로드 후 권한 설정」 | Win32-OpenSSH 위키: 「SFTP doesn't support chmod」 | Windows 대상에서 `setStat` 권한 설정을 기대하면 안 된다(Q2) |
| E | 「direct-tcpip forward … 로컬 포트 없이」 | `ClientSession.createDirectTcpipChannel(local, remote)`가 있다(Javadoc, 공식 저장소). 문서 본문(port-forwarding.md)은 이 방식을 설명하지 않는다 | 소스 근거만 있음(Q1) |
| F | 「ProxyJump」 | 2.6.0부터 `HostConfigEntry`의 ProxyJump를 따른다(공식 문서). 체인·캐스케이드는 2.13.0 이후, 상한 `MAX_PROXY_JUMPS` 10 | 정합 |
| G | 「jpackage --launcher-as-service(Windows·Linux)」 | `--launcher-as-service`는 「installer」를 만드는 옵션이다. 문서상 Windows MSI/EXE(WiX)와 Linux DEB/RPM(systemd 유닛 파일 자원)이 해당한다. `--type app-image`에서의 동작은 문서에 없다. 또 jpackage는 플랫폼별 빌드 필수다 | 계획의 산출물은 `.zip`·`.tar.gz` 묶음+`install.*`이라 이 옵션과 맞지 않는다. 쓰려면 산출물이 exe/msi/deb/rpm이 된다(Q3·Q4) |
| H | 「Windows 서비스 래퍼: procrun 후보」 | procrun은 `//IS` 설치, `--Jvm`(jvm.dll 경로 또는 auto), `--StartMode=jvm` 지원. jvm 모드는 start 메서드가 stop 호출 전까지 반환하면 안 되고, `static void main(String[])` 형태의 시작·종료 메서드가 필요하다. 문서 판 1.6.1. 64비트에서 32비트 레지스트리 뷰를 쓴다. Spring Boot 공식 문서는 Windows 서비스로 winsw만 언급하고 procrun은 언급하지 않는다 | procrun 사용은 가능하나 jvm 모드면 start/stop 진입 클래스가 필요하다(Q4) |
| I | 「설정 파일을 쓴 뒤 앱이 정해진 종료 코드로 끝나면 systemd `Restart=`가 다시 띄운다」 | 종료 코드 0, SIGTERM 등과 `SuccessExitStatus=` 항목은 「clean exit」이다. `Restart=on-failure`는 clean exit에 재시작하지 않는다. 특정 코드로 재시작하려면 `RestartForceExitStatus=`에 그 코드를 넣어야 한다. `systemctl stop`이면 재시작하지 않는다 | 종료 코드는 0이 아닌 값으로 정하고 `RestartForceExitStatus=`를 쓴다(Q5) |
| J | 「hook 입구는 hooks/*.json의 이벤트·의미를 유지」 / D-0045 「Claude·Codex 모두 `agent_id`로 서브에이전트 분리」 | Claude: `agent_id`는 공통 입력 필드로 문서화돼 있다. **Codex: `agent_id`는 SubagentStart·SubagentStop·모델 요청 hook에만 문서화돼 있고, PostToolUse·UserPromptSubmit·Stop 입력 목록에는 없다. 또 「Subagent hooks use the parent session id.」** | Codex에서 PostToolUse 입력의 `agent_id`로 서브에이전트를 가르는 전제는 공식 문서로 뒷받침되지 않는다(Q6) |
| K | claude-code.json의 `rewakeMessage`·`rewakeSummary` | Claude hooks 문서의 command 필드 표는 `command, args, async, asyncRewake, shell, onFailure`다. 두 필드는 읽은 범위에서 없다 | 문서화되지 않은 필드(Q6) |
| L | claude-code.json SessionEnd `timeout: 10` | 「SessionEnd hooks have a default timeout of 1.5 seconds.」 「Timeouts set on plugin-provided hooks don't raise the budget.」 | 플러그인으로 설치하면 JVM 런처가 1.5초 안에 못 끝나면 취소된다(Q6) |
| M | Antigravity 「`node ./scripts/portal-files.mjs`」(상대 경로) | hook command의 작업 디렉터리·환경 변수·종료 코드 의미가 문서에 없다 | 상대 경로 전제 미확인(Q6) |
| N | 「Playwright for Java(chromium·firefox·webkit)」 | 공식 문서는 Maven 예시(1.64.0)와 Gradle 의존성 한 줄을 둘 다 준다. 브라우저 설치는 CLI `install`(`--with-deps`) | 정합(Q7) |
| O | 「sqlite-jdbc(이전 모듈) Windows x64·Linux arm64」 | README 표에서 Linux(libc)는 8개 아키텍처 전부 체크다. Windows는 체크 4개인데 열 위치를 텍스트로 알 수 없다 | Windows x86_64 지원은 표에서 미확인(Q8) |

## Q1. Apache MINA SSHD

### 판·좌표
- 결론: 최신 안정판 2.20.1, 좌표 `org.apache.sshd:sshd-core`, `org.apache.sshd:sshd-sftp`(artifact 이름은 README의 `sshd-common`, `sshd-core`, `sshd-sftp`, `sshd-scp`). 3.0.0-M1~M7은 마일스톤이다.
- 인용: 「Latest SSHD Release: 2.20.1」 (https://mina.apache.org/sshd-project/downloads.html)
- 인용: Maven 메타데이터 `<latest>3.0.0-M7</latest>`, `<release>3.0.0-M7</release>`, `lastUpdated 20261028212006`, 목록 끝 `2.20.1`, `3.0.0-M1`~`3.0.0-M7` (https://repo1.maven.org/maven2/org/apache/sshd/sshd-core/maven-metadata.xml). 마일스톤을 안정판으로 오인하지 말 것.
- 인용(Java): 「Java 8+ at runtime (as of version 2.3)」, 「Java 17+ at build time (as of version 2.14)」 (https://github.com/apache/mina-sshd, README). Java 25에서의 동작 언급은 찾지 못함(미확인).
- 2.20.1 릴리스 노트: https://mina.apache.org/sshd-project/download_2.20.1.html. 변경은 GH-925(none 인증 회귀), GH-927(키 교환 경쟁 상태), GH-904(로컬 포트 표기)뿐이고 Java 25·Windows 언급은 없다.

### exec 채널(종료 코드·stderr 분리·signal/close)
- 결론: `ClientSession.createExecChannel(String)`으로 채널을 만들고, `setErr(OutputStream)`/`getInvertedErr()`로 stderr를 분리하며, `getExitStatus()`(Integer)와 `getExitSignal()`(String)을 `waitFor(Collection<ClientChannelEvent>, …)` 뒤에 읽는다. 시간 한도는 `waitFor`의 timeout 또는 `executeRemoteCommand(…, Duration)`.
- 인용(2.20.1 ClientSession.java, 공식 저장소): 「Create a channel to execute a command using default PTY settings and environment.」 `default ChannelExec createExecChannel(String command) throws IOException`
- 인용(ClientChannel.java, master, 공식 저장소): `Integer getExitStatus();` 「@return The signaled exit status via "exit-status" request - {@code null} if not signaled」 / `String getExitSignal();` 「@return The signaled exit signal via "exit-signal" - {@code null} if not signaled」 / `Set<ClientChannelEvent> waitFor(Collection<ClientChannelEvent> mask, long timeout);` 「The actual signaled event - includes {@link ClientChannelEvent#TIMEOUT} if timeout expired before」 / `InputStream getInvertedErr();` 「This is an alternative to {@link #setErr(OutputStream)}.」 / `void setErr(OutputStream err);` 「Sets an output stream for the channel to write received {@link SshConstants#SSH_MSG_CHANNEL_EXTENDED_DATA} data」
- 인용(docs/client-setup.md): 「try (ClientChannel channel = session.createExecChannel(command))」, 「Wait (forever) for the channel to close - signalling command finished」. 이 문서는 종료 상태·exit-signal을 설명하지 않는다(미확인: 문서 본문). `ClientChannelEvent` 열거값은 읽지 못했다.
- 인용(executeRemoteCommand 6번째 오버로드, 2.20.1): 「A zero or negative value means no timeout.」 그러나 본문은 `timeout.isNegative()`이면 `IllegalArgumentException("Timeout must be non-negative")`를 던진다(도구가 보고한 Javadoc과 코드의 불일치). 음수 timeout을 쓰지 않는다.
- 채널 close 시간: `CHANNEL_CLOSE_TIMEOUT` 기본 5초, 「If the message can not be written before the specified timeout elapses, the channel will be immediately closed.」 (CoreModuleProperties.java 2.20.1).
- 판본: ClientSession·CoreModuleProperties는 2.20.1 태그, ClientChannel은 master(3.0 라인). 2.20.1의 ClientChannel 시그니처는 직접 확인하지 못했다(미확인, 2.x에도 있을 것이라는 것은 추정).

### SFTP 클라이언트
- 결론: `SftpClientFactory.instance()`로 만든다. 업로드·다운로드는 `open(path, Collection<OpenMode>)` + `write/read`, 삭제는 `remove`, 이름 변경은 `rename(old, new, CopyMode...)`, 확장은 `getExtension(...)`. 권한 오류는 `SftpException.getStatus()`가 `SSH_FX_PERMISSION_DENIED = 3`이다.
- 인용(docs/sftp.md): 「A default client factory implementations is provided in the module - see `SftpClientFactory.instance()`」, 「The SFTP subsystem code supports versions 3-6 (inclusive), and by default attempts to negotiate the highest」
- 인용(SftpClient.java 2.20.1): `default void rename(String oldPath, String newPath, CopyMode... options) throws IOException`, `CloseableHandle open(String path, Collection<OpenMode> options) throws IOException;` 「Opens a remote file with the specified mode(s)」, `void remove(String path) throws IOException;`, `void write(Handle handle, long fileOffset, byte[] src, int srcOffset, int len) throws IOException;`, `Attributes stat(String path)`, `void setStat(String path, Attributes attributes)`. `CopyMode` 값과 rename의 Javadoc은 읽지 못했다(미확인).
- 인용(SftpException.java 2.20.1): 「public class SftpException extends IOException {」, 「public int getStatus() {」
- 인용(SftpConstants.java 2.20.1): `SSH_FX_OK = 0`, `SSH_FX_EOF = 1`, `SSH_FX_NO_SUCH_FILE = 2`, `SSH_FX_PERMISSION_DENIED = 3`, `SSH_FX_FAILURE = 4`, `SSH_FX_BAD_MESSAGE = 5`, `SSH_FX_NO_CONNECTION = 6`, `SSH_FX_CONNECTION_LOST = 7`, `SSH_FX_OP_UNSUPPORTED = 8`, `SSH_FX_FILE_ALREADY_EXISTS = 11`, `SSH_FX_NO_SPACE_ON_FILESYSTEM = 14`, `SSH_FX_QUOTA_EXCEEDED = 15`. D-0012·D-0013의 「용량·권한·전송 오류 구분」에 쓸 수 있는 코드이나, 서버(OpenSSH sftp-server)가 어떤 코드를 돌려주는지는 이 문서들로는 알 수 없다(미확인). 참고: OpenSSH 프로토콜 v3에는 `SSH_FX_NO_SPACE_ON_FILESYSTEM`이 없다는 점은 이 조사에서 공식 문서로 확인하지 않았다.
- posix-rename: 「`posix-rename@openssh.com` - only client side」, 인터페이스 `OpenSSHPosixRenameExtension extends SftpClientExtension` 「Implements the "posix-rename@openssh.com" extension」, `void posixRename(String oldPath, String newPath) throws IOException;` (docs/sftp.md, 해당 소스 2.20.1)
- 인용(docs/sftp.md, 확장): 「Furthermore several [OpenSSH SFTP extensions] are also supported:」 `fsync@openssh.com`, `fstatvfs@openssh.com`, `hardlink@openssh.com`, `posix-rename@openssh.com - only client side`, `statvfs@openssh.com`, `lsetstat@openssh.com`, `limits@openssh.com`
- 인용(docs/sftp.md, 클라이언트): 「On the client side, all the supported extensions are classes that implement `SftpClientExtension`.」 서버 지원 여부 확인 후 쓰는 구조다.

### direct-tcpip 포트 포워딩
- 결론: 로컬 포트를 열지 않고 채널 스트림만 쓰는 방법은 `ClientSession.createDirectTcpipChannel(SshdSocketAddress local, SshdSocketAddress remote)`이다. 문서 본문은 로컬 바인딩 방식(트래커)만 설명한다.
- 인용(2.20.1 ClientSession.java, 공식 저장소): 「Create a direct tcp-ip channel which can be used to stream data to a remote port from the server.」 `ChannelDirectTcpip createDirectTcpipChannel(SshdSocketAddress local, SshdSocketAddress remote) throws IOException;`
- 인용(같은 파일): 「Starts a local port forwarding and returns a tracker that stops the forwarding when the {@code close()} method is called.」 (`createLocalPortForwardingTracker`, `ExplicitPortForwardingTracker`)
- 인용(docs/port-forwarding.md): 「By default, this capability is **disabled**.」 (서버·클라이언트 모두 `setForwardingFilter` 필요), 문서는 `createDirectTcpipChannel`을 다루지 않는다(미확인: 문서 본문). 이 채널의 사용법(스트림 획득, 열기 순서)은 이번에 `ChannelDirectTcpip` 소스를 읽지 않아 미확인이다.
- 서버 쪽 전제(추정이 아닌 공식 문서): Windows OpenSSH의 미지원 설정 목록에 `AllowStreamLocalForwarding`, `PermitTunnel`이 있다. `AllowTcpForwarding`은 그 목록에 없다(https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration). direct-tcpip가 실제로 동작하는지는 미확인.

### 서버 호스트 키 검증(TOFU)
- 결론: `KnownHostsServerKeyVerifier`가 known_hosts 파일로 검증한다. 모르는 호스트는 생성자에 준 위임 `ServerKeyVerifier`가 정하고, 위임이 받아들이면 파일에 추가한다(TOFU를 직접 구현할 자리). 키가 바뀐 경우는 `ModifiedServerKeyAcceptor`가 없으면 거부한다.
- 인용(docs/client-setup.md): 「`KnownHostsServerKeyVerifier`: "file to validate the server key."」 「One can use this class + some existing code to **update** the file when new servers are detected and their keys are accepted.」, `AcceptAllServerKeyVerifier`는 기본값이며 「simply logs a warning that an un-verified server key was accepted」, `RejectAllServerKeyVerifier` 「rejects all server key - usually used in tests or as a fallback verifier」, `RequiredServerKeyVerifier` 「accepts only **one** specific server key (similar to certificate pinning for SSL)」. 
- 주의: MINA 클라이언트의 기본 검증기는 모든 키를 받아들인다. 검증을 설정하지 않으면 TOFU가 아니라 무검증이다.
- 인용(KnownHostsServerKeyVerifier.java, master, 공식 저장소): `acceptUnknownHostKey` 「Invoked if none of the known hosts matches the current one - by default invokes the delegate.」, 위임이 받아들이면 `updateKnownHostsFile(...)`로 항목을 추가. `getModifiedServerKeyAcceptor` 「If {@code null} then assumed to reject such a modification.」
- 문서 본문에 `ModifiedServerKeyAcceptor`와 「trust on first use」라는 말은 없다(미확인). 위 동작은 master 소스에서 읽은 것이고 2.20.1 소스는 읽지 않았다.

### ProxyJump
- 인용(docs/internals.md): 「Starting from SSHD version 2.6.0, the _ProxyJump_ host configuration entry is honored」, 「In order to manually configure jumps, you need to build a `HostConfigEntry` with a `proxyJump`」, 「The configuration options specified in the configuration file for the jump hosts are also honored.」
- 인용(CoreModuleProperties.java 2.20.1): `MAX_PROXY_JUMPS` 「Configuration value for the maximum number of proxy jumps to allow in an SSH connection; by default 10.」
- 캐스케이드(점프 호스트가 다시 ProxyJump를 갖는 경우)는 2.13.0 릴리스에서 추가(검색 결과의 2.13.0 릴리스 노트 요약이며 원문은 읽지 못함, 미확인). SOCKS·HTTP 프록시는 MINA 2.x에서 지원하지 않는다는 GitHub 이슈 #309의 보고가 있다(이슈 본문, 공식 저장소, 미확인 수준).

### keepalive/heartbeat·연결 끊김 감지
- 인용(CoreModuleProperties.java 2.20.1): `HEARTBEAT_INTERVAL` 「Key used to set the heartbeat interval in milliseconds (0 to disable = default)」 `Duration.ZERO`; `HEARTBEAT_REQUEST` 기본 `"keepalive@sshd.apache.org"`; `HEARTBEAT_REPLY_WAIT` 「@deprecated since 2.13.0, use {@link #HEARTBEAT_NO_REPLY_MAX} instead」 (기본 5분); `IDLE_TIMEOUT` 「Key used to retrieve the value of idle timeout after which it will close the connection - in milliseconds.」 기본 10분; `NIO2_READ_TIMEOUT` 기본 0; `AUTH_TIMEOUT` 기본 2분; `SOCKET_KEEPALIVE` 기본 `false`.
- 인용(docs/client-setup.md): 「The feature is controlled via the `CoreModuleProperties#HEARTBEAT_REQUEST` and `HEARTBEAT_INTERVAL` properties」, 「If specified timeout expires for the `wantReply` option then session will be **closed**.」
- 연결 끊김 감지 API: docs/event-listeners.md는 `SessionListener`가 「Informs about session related events.」이고 `sessionClosed`를 예시로 든다. `SessionDisconnectHandler`는 「session disconnect initiated by the internal code due to various protocol requirements」를 감시한다. 「끊긴 세션을 사전 감지」(D-0038)에 `HEARTBEAT_INTERVAL`+`SessionListener.sessionClosed`+`ClientSession` 상태(`getSessionState`, ClientSession 메서드 목록에 있음)를 쓸 수 있다는 것까지가 근거다. 이들을 결합했을 때의 지연·정확도는 문서에 없다(미확인).

### Windows OpenSSH 서버와의 호환 공식 언급
- 찾지 못함. 확인한 곳: https://github.com/apache/mina-sshd (README), docs/standards.md(2.20.1), docs/sftp.md, docs/client-setup.md, docs/internals.md. `standards.md`에는 Windows·Win32-OpenSSH·상호운용 시험 언급이 없다. `sftp.md`의 「On Windows you'll typically not see any improvement because the file system stores attributes differently」는 디렉터리 목록 성능 이야기이며 호환 언급이 아니다.

## Q2. Windows OpenSSH 서버

- 결론: 기본 셸은 `cmd.exe`이고 레지스트리 `HKLM:\SOFTWARE\OpenSSH`의 `DefaultShell`로 바꾼다. SFTP 서브시스템은 `Subsystem sftp sftp-server.exe` 줄이며, 설정은 `%programdata%\ssh\sshd_config`다. 경로 형식에 관한 마이크로소프트 공식 설명은 찾지 못했다.
- 인용: 「The initial default in Windows is the Windows command prompt (cmd.exe).」 「You can configure the default ssh shell in the Windows registry by adding the full path to the shell executable to `HKEY_LOCAL_MACHINE\SOFTWARE\OpenSSH` in the string value `DefaultShell`.」 (https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration, ms.date 2025-08-05)
- 인용: 「OpenSSH Server reads configuration data from `%programdata%\ssh\sshd_config` by default.」 「For Windows OpenSSH, the only available authentication methods are `password` and `publickey`.」 「If the user belongs to the administrator group, `%programdata%/ssh/administrators_authorized_keys` is used instead.」 (같은 문서)
- 인용(SFTP 서브시스템): 「Make sure that the entries don't have any trailing spaces, and make sure that the `Subsystem sftp sftp-server.exe` command is present.」 「Subsystem sftp sftp-server.exe -f LOCAL0 -l DEBUG3」 「OpenSSH on Windows provides secure file transfer protocol (SFTP) capabilities.」 (https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/troubleshoot-sftp-issues-using-openssh, ms.date 2026-02-12)
- 인용(설치 상태): 「Beginning with Windows 10 build 1809 and Windows Server 2019, OpenSSH is available as a feature on demand.」 Windows Server 2025 「Installed but not enabled」, Server 2019/2022·Windows 10 1809+ 「Not installed, install and enable using optional features」 (https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview, ms.date 2025-02-20)
- 인용(제약, 공식 저장소 위키): 「SFTP doesn't support chmod」 (https://github.com/PowerShell/Win32-OpenSSH/wiki/Various-Considerations)
- 인용(소스, 공식 저장소 PowerShell/openssh-portable 브랜치 latestw_all, sftp-server.c): `{ "posix-rename", "posix-rename@openssh.com", 0, process_extended_posix_rename, 1 }`가 확장 표에 있고 `compose_extension(msg, "posix-rename@openssh.com", "1");`로 광고된다. 일반 rename은 대상이 있으면 `SSH2_FX_FAILURE`로 끝난다(도구가 소스를 읽고 보고한 해석).
- 경로 형식: 마이크로소프트 문서·위키에서 SFTP 경로 형식(`/C:/…` 등) 설명을 찾지 못했다(미확인). 확인한 곳: openssh-server-configuration, openssh-overview, troubleshoot-sftp-issues, Win32-OpenSSH 위키 Various-Considerations. 검색에 나온 `/C:/` 사용례는 이슈 댓글 수준이라 근거로 쓰지 않는다. 실측이 필요하다.
- 기타 제약(인용): 「`ChrootDirectory` points to a local directory and doesn't use a UNC path.」, `AllowStreamLocalForwarding`·`PermitTunnel`·`AuthorizedKeysCommand` 등은 「aren't available in the OpenSSH version that ships in Windows Server and Windows」.

## Q3. JDK 25 jlink·jpackage

- 결론: jlink는 `--module-path`·`--add-modules`·`--output`으로 런타임 이미지를 만든다. jpackage는 각 형식을 해당 플랫폼에서 빌드해야 하고 크로스 빌드가 없다. jlink 자체의 플랫폼 제약 언급은 해당 man 페이지에 없다.
- 인용(https://docs.oracle.com/en/java/javase/25/docs/specs/man/jlink.html): 「The `jlink` tool links a set of modules, along with their transitive dependences, to create a custom runtime image.」 「**Note:** Developers are responsible for updating their custom runtime images.」 `--add-modules` 「Adds the named modules, _mod_, to the default set of root modules. The default set of root modules is empty.」 `--output` 「Specifies the location of the generated runtime image.」 `--module-path` 「If this option is not specified, then the default module path is `$JAVA_HOME/jmods`.」 `--bind-services` 「Link service provider modules and their dependencies.」 `--strip-debug` 「Strips debug information from the output image.」 `--compress` 0/1/2 「2: ZIP」 `--no-header-files`, `--no-man-pages`.
- jlink 페이지에서 찾지 못한 것: 다른 플랫폼 jmods로 크로스 링크하는 것에 관한 문장, `--strip-native-commands`, `--release-info`.
- 인용(https://docs.oracle.com/en/java/javase/25/docs/specs/man/jpackage.html, JDK 25): 「Each format must be built on the platform it runs on, there is no cross-platform support.」 `--type` 「Valid values are: {"app-image", "exe", "msi", "rpm", "deb", "pkg", "dmg"}」 `--runtime-image` 「If --runtime-image is not specified, jpackage will run jlink to create the runtime image using options specified by --jlink-options.」
- 인용(https://docs.oracle.com/en/java/javase/25/jpackage/packaging-overview.html): 「Application packages must be built on the target platform.」 「To package your application for multiple platforms, you must run the packaging tool on each platform.」 Windows 「exe, msi」 「WiX 3.0 or later is required.」, Linux 「deb, rpm」 「For Red Hat Linux, the rpm-build package is required.」 「For Ubuntu Linux, the fakeroot package is required.」, `--type app-image` 「To test before building an installer, use `--type app-image` to create only the image.」
- 계획과의 대조: 계획은 jlink 런타임과 실행 jar를 `.tar.gz`·`.zip`에 직접 묶고, jpackage를 PC 클라이언트 런처(인정 예외)로 둔다. jpackage 문서상 app-image는 `bin/` 런처와 `lib/runtime`을 가진 디렉터리이며 이것을 압축해 배포하는 것은 문서가 금지하지 않는다(문서는 「The application image generated by the tool works for most applications.」라고만 함). 설치 패키지 형식(exe/msi/deb/rpm)을 만들 때만 WiX·rpm-build·fakeroot가 필요하다. Linux arm64 산출물은 arm64 러너에서 빌드해야 한다는 해석은 「must be built on the target platform」에서 나온다.

## Q4. Windows에서 Java 앱을 서비스로 돌리는 방법

### Apache Commons Daemon procrun
- 판본: 페이지 표기 1.6.1, 2026-05-31 게시 (https://commons.apache.org/proper/commons-daemon/procrun.html).
- 인용: 서비스 명령 「//IS … Install service.」 「//US … Update service parameters.」 「//DS … Delete service」(실행 중이면 먼저 정지), 「//RS … Called only from ServiceManager.」
- 인용(옵션): `--Install` 기본 `procrun.exe //RS//ServiceName`; `--Jvm` 기본 `auto`(「auto」 또는 jvm.dll 전체 경로); `--StartMode`/`--StopMode` 값 `jvm`, `Java`, `exe`; `--StartClass`/`--StopClass` 기본 `Main`; `--StartMethod`/`--StopMethod` 기본 `main`(「static void」에 `(String args[])`, jvm 모드만); `--Classpath`; `--JvmOptions` 기본 `-Xrs`; `--StartPath`; `--LogPath`; `--StdOutput`; `--ServiceUser`(DomainName\UserName); `--Startup`(`delayed`, `auto`, `manual`).
- 인용(jvm 모드 종료 처리): 「the start method should not return until the stop method has been called.」 start·stop 메서드는 서로 다른 스레드에서 실행. `--StopTimeout` 기본 60초 「Defines the timeout in seconds that procrun waits for service to stop.」 시간이 지나면 서비스 프로세스 트리를 kill 시도.
- 인용(Java·exe 모드): Java 모드는 exe 모드와 같지만 기본 Java 실행 파일 `%JAVA_HOME%\bin\java.exe`를 쓰고, 대상 애플리케이션을 별도 프로세스로 띄운다.
- 인용(64비트 주의): 「On 64-bit Windows, procrun always uses the 32-bit registry view.」 (설정은 `HKEY_LOCAL_MACHINE\SOFTWARE\Wow6432Node\...`)
- 이 페이지에서 찾지 못한 것: 래퍼가 서비스 제어 관리자(SCM) 인터페이스를 구현한다는 문장, Windows 지원 버전.

### jpackage --launcher-as-service의 Windows 동작
- 인용: 「Request to create an installer that will register the main application launcher as a background service-type application.」 (JDK 25 jpackage man 페이지)
- 인용(리소스 디렉터리, Windows MSI/EXE): `service-installer.exe` 「Service installer executable.」 「Considered if some application launchers are registered as background service-type applications.」, `<launcher-name>-service-install.wxi`, `<launcher-name>-service-config.wxi` 「Service installer WiX project file.」
- 인용(리소스 디렉터리, Linux DEB/RPM): `<package-name>-<launcher-name>.service` 「systemd unit file for application launcher registered as a background service-type application.」 기본 자원 `unit-template.service`.
- JBS 문서(JDK-8275062)는 WebFetch가 403으로 읽히지 않았다. 검색 결과 요약에 따르면 Windows exe/msi를 지원하고 `--win-console`과 함께 쓰면 실패하며 「Java app launcher is service workload. It can not be used as-is as service manager because it doesn't implement service control interface.」라고 한다. 이 인용은 검색 결과 요약이므로 원문 확인 전까지 미확인으로 둔다.
- 세션 정지 시 Java 종료 처리 방식(예: 어떤 신호·훅으로 JVM에 알리는지)은 JDK 25 man 페이지에 없다(미확인).

### sc.exe로 일반 java.exe를 서비스로 등록할 수 없는 이유
- 결론: 서비스로 등록되는 실행 파일은 SCM 규약(진입점에서 `StartServiceCtrlDispatcher` 호출, `ServiceMain`, 제어 핸들러)을 구현해야 한다. `sc create`는 경로만 등록하며 래핑하지 않는다. `java.exe`는 그 규약을 구현하지 않으므로, 그대로 등록하면 SCM과 연결하지 못한다.
- 인용(https://learn.microsoft.com/en-us/windows/win32/services/service-programs): 「The following topics describe the interface requirements of the service control manager (SCM) that a service program must include:」 Service Entry Point, Service ServiceMain Function, Service Control Handler Function.
- 인용(https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicectrldispatchera): 「When the service control manager starts a service process, it waits for the process to call the **StartServiceCtrlDispatcher** function. The main thread of a service process should make this call as soon as possible after it starts up (within 30 seconds).」 `ERROR_FAILED_SERVICE_CONTROLLER_CONNECT` 「This error is returned if the program is being run as a console application rather than as a service.」
- 인용(https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create): `binpath= <binarypathname>` 「Specifies a path to the service binary file.」 (「Creates a subkey and entries for a service in the registry and in the Service Control Manager database.」) `sc create`는 등록만 하며 실행 파일이 SCM 규약을 구현하는지는 확인하지 않는다.
- 「java.exe를 sc로 등록하면 어떻게 되는가」를 직접 서술한 공식 문장은 찾지 못했다. 위 두 문서에서 도출한 해석이다(추정).

### 서비스 등록용으로 알맞은 쪽(근거에서 도출한 판단, 확정은 메인)
- Spring Boot 공식 문서(https://docs.spring.io/spring-boot/how-to/deployment/installing.html, Spring Boot 4.1.2)는 Windows에 관해 「A Spring Boot application can be started as a Windows service by using [`winsw`](https://github.com/kohsuke/winsw).」만 적는다. procrun은 언급하지 않는다.
- cmd 스크립트에서 `procrun.exe //IS//<이름> --Install=… --Jvm=<런타임>\bin\server\jvm.dll --StartMode=jvm --StartClass=… --StopMode=jvm --StopClass=…`로 한 줄 등록이 가능하다는 것이 procrun 문서의 구조다. 필요한 전제: (1) jvm 모드의 start/stop은 `static void main(String[])` 형태의 진입 클래스가 필요하고 start는 stop 호출 전까지 반환하지 않아야 하므로 Spring Boot 앱을 감싸는 작은 Java 클래스가 있어야 한다. (2) `--Jvm`에 jlink 런타임의 jvm.dll 경로를 준다(문서상 값은 `auto` 또는 jvm.dll 경로). (3) procrun.exe는 별도 배포물이라 묶음에 동봉해야 한다. 이 조사에서 Commons Daemon 배포 파일·라이선스 페이지는 확인하지 않았다(미확인). Java 모드(`--StartMode=Java`)는 `java.exe`를 자식 프로세스로 띄우는 방식이라 진입 클래스가 필요 없지만, 종료 신호 전달은 문서에서 확인하지 못했다.
- jpackage `--launcher-as-service`는 exe/msi 설치 프로그램을 만드는 흐름(WiX 3.0 이상 필요)에서만 서비스가 등록된다. 계획의 `install.cmd` 흐름과는 맞지 않는다(`--type app-image`에서의 동작은 문서에 없음).

## Q5. Linux systemd (systemd.service, 문서 판 systemd 262)

- URL: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html, https://www.freedesktop.org/software/systemd/man/latest/systemctl.html, https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
- `Restart=`: 기본 `no`. 값 `no`, `on-success`, `on-failure`, `on-abnormal`, `on-watchdog`, `on-abort`, `always`. 「Configures whether the service shall be restarted when the service process exits, is killed, or a timeout is reached.」 clean exit = 종료 코드 0, 신호 SIGHUP·SIGINT·SIGTERM·SIGPIPE, 또는 `SuccessExitStatus=`에 있는 값. 수동 정지(「stopped with **systemctl stop** or an equivalent operation」)이면 재시작하지 않는다.
- `RestartForceExitStatus=`: 「will force automatic service restarts, regardless of the restart setting.」
- `RestartPreventExitStatus=`: 「will prevent automatic service restarts, regardless of the restart setting configured with `Restart=`.」
- `SuccessExitStatus=`: 「will be considered successful termination, in addition to the normal successful exit status 0.」
- `RestartSec=` 기본 100ms. `Type=exec`: 주 서비스 바이너리가 실행된 뒤 시작된 것으로 본다. `TimeoutStopSec=` 초과 시 SIGKILL.
- `User=`: systemd.exec 「Set the UNIX user or group that the processes are executed as, respectively.」 `DynamicUser=` 없이 쓰면 「must have been created statically in the user database no later than the moment the service is started.」 「If the user does not exist by then program invocation will fail.」 따라서 설치 스크립트가 서비스 사용자를 먼저 만들어야 한다. 이 만드는 일이 Java 설치 명령의 몫인지 스크립트의 몫인지는 계획 결정이 필요하다(`useradd`는 외부 명령).
- `systemctl daemon-reload`: 「Reload the systemd manager configuration.」 `enable`: 「Note that this does _not_ have the effect of also starting any of the units being enabled.」 `enable --now`: `--now`는 enable·disable·mask·reenable과 함께 쓰면 「also start/stop/try-restart the units after the specified unit file operations succeed.」 enable은 심볼릭 링크를 만든 뒤 설정을 다시 읽는다(「equivalent to **daemon-reload**」). 새 유닛 파일을 쓴 뒤 `enable --now` 전에 별도 `daemon-reload`가 필요한지는 이 문서로 단정하지 못했다(문서는 enable이 reload를 포함한다고 적음). 
- Spring Boot 공식 문서(Spring Boot 4.1.2)의 유닛 예: `Type=exec`, `ExecStart=/path/to/java/home/bin/java -jar /var/myapp/myapp.jar`, `WorkingDirectory=/var/myapp`, `SuccessExitStatus=143`, `[Install] WantedBy=multi-user.target`, 「To flag the application to start automatically on system boot, use the following command: `$ systemctl enable myapp.service`」. `SuccessExitStatus=143`은 JVM이 SIGTERM을 종료 코드 143으로 끝내는 경우에 대비한 것이다(이유 문장은 Spring 문서에 없음, 추정).
- 계획 4단계 「앱이 정해진 종료 코드로 끝나면 `Restart=`가 다시 띄운다」: 위 인용대로 코드 0은 clean exit라 `Restart=on-failure`로는 재시작되지 않는다. 0이 아닌 코드를 정해 `RestartForceExitStatus=`에 넣어야 한다.

## Q6. 호스트 hook 공식 문서

### (a) Claude Code (https://code.claude.com/docs/en/hooks, 읽은 범위: 앞 30만 자 중 0~10만, 10만~20만 일부, 20만 이후 일부)
- 이벤트(33개): 「`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`」
- 저장소가 쓰는 SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd는 모두 문서에 있다.
- 핸들러 타입: 「There are five types:」 `command`, `http`, `mcp_tool`, `prompt`, `agent`. command 필드: `command`, `args`, `async`, `asyncRewake`, `shell`, `onFailure`. `timeout` 기본: 「600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`.」 mcp_tool 필드 `server`, `tool`, `input`.
- `args`: 「When present, `command` is resolved as an executable and spawned directly with `args` as the argument vector, with no shell involved.」 저장소의 `{"command":"node","args":[…]}` 형태와 일치한다(Java 런처로 바꿀 때도 같은 형태 가능).
- `async`: 「If `true`, runs in the background without blocking.」 「This field is only available on `type: "command"` hooks.」 async hook은 `decision` 등을 무시한다. 「Once an async hook is running in the background, Claude Code doesn't enforce `timeout` on it. Claude Code still enforces `timeout` on a hook you run with `asyncRewake`.」
- `asyncRewake`: 「If `true`, runs in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as a system reminder」 「Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle.」 따라서 Java `--wait` 런처가 깨우려면 종료 코드 2로 끝나고 메시지를 stderr(또는 stdout)로 내야 한다.
- 입력 공통 필드: `session_id` 「Current session identifier」, `cwd`, `transcript_path`, `hook_event_name` 「Name of the event that fired」, `agent_id` 「Unique identifier for the subagent or in-process teammate the hook fires in.」, `agent_type` 「Present when the session uses `--agent` or the hook fires inside a subagent.」 서브에이전트 구분: 「When a subagent calls a tool, tool events such as `PreToolUse` and `PostToolUse` fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type` common input fields that identify the subagent.」 저장소의 「input.agent_id가 있으면 자식」 판정과 맞다.
- 종료 코드 2: 「Exit with code 2 to block the action.」 「The message that comes with the block is your hook's stderr.」 표: `PostToolUse` 차단 불가 「Shows stderr to Claude; the tool already ran」, `UserPromptSubmit` 「Blocks the prompt, so it never reaches Claude」, `Stop` 「Prevents Claude from stopping, continues the conversation」, `SessionStart`·`SessionEnd` 「Shows stderr to user only」.
- 출력: PostToolUse·UserPromptSubmit·SessionStart는 `hookSpecificOutput.additionalContext`(+`hookEventName`)를 지원한다(문서 예시: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`). 저장소 `renderCompletionContext`의 모양 `{ hookSpecificOutput: { hookEventName, additionalContext } }`와 일치한다. SessionStart는 일반 텍스트 stdout도 컨텍스트가 된다.
- Stop 입력: 「Stop hooks receive `stop_hook_active`, `last_assistant_message`, `background_tasks`, and `session_crons`. The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook.」 8회 연속 계속 상한이 있다(「the 8-consecutive-continuation cap」).
- SessionEnd: 입력 `reason`(`clear`, `resume`, `logout`, `prompt_input_exit`, `other`). 결정 제어 없음. 「SessionEnd hooks have a default timeout of 1.5 seconds.」 「Timeouts set on plugin-provided hooks don't raise the budget.」(설정 파일의 hook timeout은 최대 60초까지 예산을 올린다.) 저장소 claude-code.json은 SessionEnd에 `timeout: 10`을 쓰는데, 플러그인 hook이면 1.5초 예산이 유지된다. JVM 기동이 1.5초를 넘기면 SessionEnd 처리가 취소될 수 있다(해석).
- MCP 도구: 「MCP tools follow the naming pattern `mcp__<server>__<tool>`」, 「`mcp__memory__.*` matches all tools from the `memory` server」. 「MCP server tools appear as regular tools in tool events (`PreToolUse`, `PostToolUse`, …)」라서 MCP 도구 호출도 PostToolUse hook이 걸린다. D-0044의 전제(MCP 도구 완료 뒤 자동 관찰)와 맞다.
- 플러그인 hooks 위치: 「Define plugin hooks in `hooks/hooks.json` with an optional top-level `description` field. When a plugin is enabled, its hooks merge with your user and project hooks.」 경로 변수 「`${CLAUDE_PLUGIN_ROOT}`: the plugin's installation directory」. 설정 위치: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, 관리 정책, 플러그인 `hooks/hooks.json`, 스킬·서브에이전트 frontmatter. 저장소 hooks/claude-code.json(최상위 `description`과 `hooks`)과 같은 모양이다.
- 불일치: command 필드 표에 `rewakeMessage`, `rewakeSummary`가 없다. 읽은 범위(필드 표와 20만 자 이후)에서 이 두 문자열을 찾지 못했다(10만~20만 자는 문자열 검색을 하지 않았으므로 완전한 부재 확인은 아님). 추가 필드는 무시되거나 오류가 될 수 있다. 확인되기 전에는 3.0.0 hook JSON에 그대로 옮기지 않는다.
- hook 등록의 신뢰·승인 절차(스킬·플러그인 hooks 트러스트)는 읽은 범위에서 확인하지 않았다(미확인).

### (b) OpenAI Codex (https://developers.openai.com/codex/hooks → 308 → https://learn.chatgpt.com/docs/hooks)
- 이벤트: 「During a turn: "PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStop, Stop"」, 「Per model request attempt: "PreModelRequest, PostModelRequest"」, 「On interrupt: "Interrupt"」, 「Session or subagent start: "SessionStart, SubagentStart"」, 「Main thread end: "SessionEnd"」. 저장소 codex.json의 SessionStart, UserPromptSubmit, PostToolUse, Stop은 모두 있다. (SessionEnd는 저장소가 쓰지 않는다.)
- 타입: 「`command` and `mcp_tool` handlers are supported.」 「`prompt` and `agent` handlers are parsed but skipped.」 `async`: 「Set `async` to `true` to run a command hook in the background while Codex continues.」 「Codex runs up to eight background hooks concurrently per session.」 「Background hooks can't block, approve, rewrite, or otherwise control the operation that triggered them.」 `asyncRewake`는 읽은 범위에서 없다.
- 입력 공통: `session_id` 「Current Codex session id. Subagent hooks use the parent session id.」, `transcript_path`, `cwd`, `hook_event_name`, `model`, 턴 범위 hook에는 `turn_id`. 「thread id」라는 필드는 없다(SessionEnd 예시가 `"session_id": "thr_123"`).
- 서브에이전트 식별: `agent_id` 「Identifier for the subagent」, `agent_type` 「Subagent type or profile」는 `SubagentStart`·`SubagentStop`, 그리고 「`PreModelRequest`/`PostModelRequest` … plus `agent_id` and `agent_type` when available」에만 문서화돼 있다. PostToolUse 입력 필드는 `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, UserPromptSubmit은 `turn_id`, `prompt`이고 `agent_id`는 없다. 「Interrupt … doesn’t run for subagents」, SessionEnd는 서브에이전트에서 실행되지 않는다.
- 설정 위치: 「`~/.codex/hooks.json`」, 「`~/.codex/config.toml`」, 「`<repo>/.codex/hooks.json`」, 「`<repo>/.codex/config.toml`」. 「Project-local hooks load only when the project `.codex/` layer is trusted.」
- 플러그인: 「By default, Codex looks for `hooks/hooks.json` inside the plugin root.」 「`PLUGIN_ROOT` is a Codex-specific extension that points to the installed plugin root.」 「Codex also sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` for compatibility with existing plugin hooks.」 「Manifest hook paths are resolved relative to the plugin root and must stay inside that root.」 「Non-managed hooks must be reviewed and trusted before they run.」 「Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition.」 신뢰는 hook 정의의 해시 기준이라 정의가 바뀌면 다시 신뢰해야 한다. 설치 자동화가 hook을 등록해도 사용자 신뢰 승인이 남는다.
- Windows: 「`commandWindows` is an optional Windows-only command override.」 저장소 codex.json의 `commandWindows`와 일치.
- 종료 코드: 「Exit `0` with no output is treated as success and Codex continues.」 종료 코드 2 + stderr로 차단(PreToolUse, UserPromptSubmit, PostToolUse, SubagentStop, Stop). 기본 timeout 600초, 「`SessionEnd` and `Interrupt` use `1` second by default and support up to `3` seconds.」
- 출력: SessionStart·UserPromptSubmit·PostToolUse는 `hookSpecificOutput.additionalContext`(개발자 컨텍스트로 추가). Stop은 「`Stop` expects JSON on `stdout` when it exits `0`. Plain text output is invalid for this event.」 Stop은 `additionalContext`를 목록에 두지 않는다.
- MCP 도구: 「PostToolUse … including Bash, `apply_patch`, MCP tool calls, and other local function tools.」 「Hosted tools, such as `WebSearch`」는 제외. 「Match the MCP tool name, such as `mcp__filesystem__read_file`.」 hook이 호출하는 `mcp_tool` 타입: 「An MCP tool hook lets a lifecycle event call a tool on an already-connected MCP server.」 「`SessionEnd` doesn't support MCP tool hooks.」
- 기능 플래그: 「Hooks are enabled by default.」 「Use `hooks` as the feature key. `codex_hooks` still works as a deprecated alias.」
- 스키마: 「The linked `main` branch schemas may include hook fields that are not in the current release.」 「Use this page as the release behavior reference.」
- **계획 전제와의 불일치(J)**: D-0045의 「Claude·Codex 모두 `agent_id`로 결속 분리」 중 Codex 부분. Codex 문서는 서브에이전트 hook이 부모 `session_id`를 쓴다고 적고, 도구·프롬프트 hook 입력에서 서브에이전트를 구분하는 필드를 문서화하지 않았다. 현재 저장소의 completion-hook.mjs 34~35행 주석(「Codex and Claude subagents can serialize the parent's session_id for a child.」)과 `input.agent_id` 검사는 Codex 문서만으로는 근거가 없다. Claude에는 근거가 있다. 이 불일치가 실제 동작과 같은지는 실측이 필요하다(미검증).

### (c) Google Antigravity (https://antigravity.google/docs/hooks, 읽은 범위: 한 페이지 전체 요약)
- 이벤트: 「SessionStart: "Fires once when a new conversation session starts, before the first model invocation."」 「PreToolUse: "Fires before a tool is executed."」 「PostToolUse: "Fires after a tool completes."」 「PreInvocation: "Fires before the model is called."」 「PostInvocation: "Fires immediately after each model invocation completes."」 「Stop: "Fires when execution terminates."」 다른 이벤트는 문서에 없다. 저장소 antigravity.json의 SessionStart, PreInvocation, PostToolUse, PostInvocation, Stop은 모두 문서와 맞는다.
- 설정 위치: 앱·IDE·CLI 모두 워크스페이스 `.agents/hooks.json`, 전역 `~/.gemini/config/hooks.json`. CLI는 「Hooks in `~/.gemini/antigravity-cli/settings.json` aren't loaded.」, 플러그인은 「Packaged inside an installed plugin's `hooks.json` file.」(CLI 절에만 한 줄). 제품별 데이터 디렉터리가 다르다(앱 `~/.gemini/antigravity`, CLI `~/.gemini/antigravity-cli`, IDE `~/.gemini/antigravity-ide`).
- 스키마: 「The `hooks.json` file maps hook names to their event configurations.」 훅 정의의 `enabled`(기본 true), 핸들러 `type`(「Currently only `"command"` is supported.」), `command`(필수), `timeout`(「Defaults to `30`.」). 「For `SessionStart`, `PreInvocation`, `PostInvocation`, and `Stop`, the structure is simpler... and the matcher is ignored.」 `PreToolUse`·`PostToolUse`는 matcher+중첩 `hooks` 배열. 저장소 antigravity.json이 PostToolUse를 매처 없는 평평한 목록으로 쓰는 것은, 문서가 PostToolUse를 「matcher+nested hooks」 구조로 설명한다는 요약과 어긋날 수 있다. 문서의 정확한 JSON 예시(PostToolUse)를 읽지 못해 미확인이다.
- 입출력: 「Hooks receive input through **stdin** as JSON and return output through **stdout** as JSON. Field names use camelCase.」 공통 입력 `conversationId` 「The unique UUID of the active agent conversation.」, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `lastUserInput`. PostToolUse 입력 `toolCall`, `stepIdx`, 선택 `error`, 출력은 「Returns an empty JSON object `{}`.」 SessionStart 출력 `injectSteps`. PreInvocation 출력 `injectSteps`, `terminationBehavior`. Stop 입력 `executionNum`, `terminationReason`, `fullyIdle`, 출력 `decision`: 「Set to `"continue"` to prevent the agent from stopping and re-enter the execution loop.」
- 문서에 없는 것: `session_id`, `hook_event_name`, `trajectoryId`(입력 필드 목록에 없음), 종료 코드 의미, 서브에이전트에서 hook이 실행되는지, command의 작업 디렉터리, 전달되는 환경 변수. 저장소는 `--event` 인자로 이벤트 이름을 주입하고 `conversationId`를 세션으로 쓰는 방식이라 이 부재를 피하고 있다. `node ./scripts/portal-files.mjs`의 상대 경로가 어디 기준인지는 문서에 없다(미확인, M).
- 문서에 `additionalContext` 같은 컨텍스트 주입 필드는 없고 `injectSteps`(SessionStart·PreInvocation)가 있다. PostToolUse 출력은 빈 객체라서, 현재 hook의 완료 알림을 Antigravity에 PostToolUse 출력으로 전달하는 것은 문서상 불가능하다. 알림 전달은 SessionStart·PreInvocation의 `injectSteps`에 의존해야 한다(해석, 실측 필요).
- 비공식 신호(근거로 쓰지 않음): 개발자 포럼에 Windows IDE 1.107.0에서 Stop·PostToolUse hook이 실행되지 않는다는 글이 있다. 공식 문서가 아니므로 참고만 한다.
- Antigravity hook 설치는 T-0012(BLOCKED)에 따라 제외한다는 계획과 별개로, 위 문서화되지 않은 동작 때문에 6단계 구현 전에 실측이 필요하다.

## Q7. Playwright for Java

- 판본: 1.64.0(문서 예시와 Docker 태그).
- 좌표: `com.microsoft.playwright:playwright`. 인용(https://playwright.dev/java/docs/test-runners): Gradle `implementation("com.microsoft.playwright:playwright:1.64.0")`(Kotlin DSL), `implementation 'com.microsoft.playwright:playwright:1.64.0'`(Groovy). Maven은 intro 페이지의 `pom.xml` 예시에서 groupId `com.microsoft.playwright`, artifactId `playwright`, 버전 1.64.0.
- 설치 방식: 인용(https://playwright.dev/java/docs/intro) 「downloads the Playwright package and installs browser binaries for Chromium, Firefox and WebKit」(예제 실행 시). 인용(https://playwright.dev/java/docs/ci) `mvn exec:java -e -D exec.mainClass=com.microsoft.playwright.CLI -D exec.args="install --with-deps"`. 인용(https://playwright.dev/java/docs/browsers) 「System dependencies can get installed automatically. This is useful for CI environments.」 `PLAYWRIGHT_BROWSERS_PATH`로 위치 지정, 「This can be done by setting `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` variable before installation.」 기본 캐시: Windows `%USERPROFILE%\AppData\Local\ms-playwright`, Linux `~/.cache/ms-playwright`. Gradle용 설치 명령은 문서에 없고 `./gradlew playwright --args="help"` 형태만 있다(test-runners 페이지). 「내부 드라이버」 동봉에 대한 문장은 문서에서 찾지 못했다. 공식 저장소 파일 목록에 `driver-bundle` 폴더명이 보일 뿐 설명은 없다(미확인).
- 브라우저: 「Playwright supports all modern rendering engines including Chromium, WebKit, and Firefox.」 (intro), 공식 저장소 README는 Chromium 158.0.8127.18, WebKit 27.2, Firefox 159.0을 표로 보이고 Linux·macOS·Windows 모두에 체크다. headless는 별도 「chromium headless shell」, 「you can pass `--only-shell` during installation to skip the full Chromium download.」
- 요구: 「Java 8 or higher.」 Windows 「Windows 11+, Windows Server 2019+ or Windows Subsystem for Linux (WSL).」 Linux 「Debian 12/13 and Ubuntu 22.04/24.04/26.04, on x86-64 or arm64.」
- CI: 「`- uses: actions/setup-java@v5`」, 「`distribution: 'temurin'`」, 「`java-version: '25'`」, 「For Windows or macOS agents, no additional configuration is required, just install Playwright and run your tests.」 「On Linux agents, headed execution requires Xvfb to be installed.」 Docker 이미지 `mcr.microsoft.com/playwright/java:v1.64.0-noble`.
- JUnit: 「playwright = Playwright.create(); browser = playwright.chromium().launch();」(`@BeforeAll`), 별도 JUnit 통합 페이지는 「JUnit (experimental)」로 표기(intro 사이드바).
- 계획 대조: 정합. 「GitHub Actions에서 Windows·Linux 러너」는 문서가 지지한다. 외부 프로그램 최소화 관점에서, 설치 CLI와 브라우저 바이너리 다운로드는 Playwright 라이브러리 내부 동작이다(Java 코드가 직접 외부 명령을 호출하지 않음).

## Q8. xerial sqlite-jdbc (공식 저장소 README, https://github.com/xerial/sqlite-jdbc)

- 판본: README 표기 `org.xerial:sqlite-jdbc` 3.54.1.0.
- 네이티브 라이브러리 동봉: 인용 「requires no configuration since native libraries for major OSs, including Windows, macOS, Linux etc., are assembled into a single JAR (Java Archive) file.」 「An appropriate native library file is automatically extracted into your OS’s temporary folder」, USAGE.md 「To use another directory, set `org.sqlite.tmpdir` JVM property to your favorite path.」 `-Dorg.sqlite.lib.path=/path/to/folder`(+`org.sqlite.lib.name`)로 특정 네이티브 파일 지정. 이 모듈이 3.0 제품이 아닌 `portal-migrate`에만 있다는 계획과 같이 임시 폴더 추출이 일어난다.
- 지원 OS·아키텍처: 표 열 머리글 x86, x86_64, armv5, armv6, armv7, arm64, ppc64, riscv64. 텍스트로 읽힌 행: 「Windows ✔ ✔ ✔ ✔」, 「Linux (libc) ✔ ✔ ✔ ✔ ✔ ✔ ✔ ✔」, 「Linux (musl) ✔ ✔ ✔」. Linux(libc)는 체크 8개라 x86_64·arm64를 포함한다. **Windows는 체크 4개이고 어느 열인지 알 수 없어 x86_64·arm64 지원은 미확인이다.** (표 렌더링을 확인하지 못함)
- 읽기 전용: README에는 없다. USAGE.md에서 「// config.setReadOnly(true);」(SQLiteConfig 예시), 「Driver-only keys (not SQLite PRAGMAs) include `open_mode`, `shared_cache`, `enable_load_extension`」, 「allow setting `readOnly` only if no statement has been executed yet」, 「`SQLiteConfig#setExplicitReadOnly(true)`」, 「using the pragma `jdbc.explicit_readonly`」를 찾았다. `SQLiteOpenMode`·`mode=ro` URI는 문서에서 찾지 못했다(미확인). 읽기 전용 열기는 `SQLiteConfig.setReadOnly(true)`를 쓰는 방식이 문서 예시에 있다.
- Java 요구 버전·Java 24+의 네이티브 접근 경고(`--enable-native-access`)에 관한 언급은 README·USAGE.md에서 찾지 못했다(미확인). Java 25에서 JNI 네이티브 로드 시 경고가 나는지는 문서로 알 수 없다. 제품 규칙(`--add-opens` 금지)과 별개로 실측이 필요하다.
- GraalVM: 「Sqlite JDBC supports GraalVM native-image out of the box starting from version 3.40.1.0.」

## Q9. Cloudflare Access JWT (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/, 문서 갱신 표기 Nov 2, 2026)

- 헤더: 「Cf-Access-Jwt-Assertion」. 쿠키 `CF_Authorization`. 문서는 헤더 검증을 권한다(「the cookie is not guaranteed to be passed」).
- JWKS 위치: 「https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs」.
- aud: 「The `aud` claim in the token payload specifies which application the JWT is valid for.」 AUD 태그는 대시보드 Zero Trust → Access controls → Applications → Edit → Additional settings의 「Application Audience (AUD) Tag」.
- 검증: 수동 방법은 `iss`가 팀 도메인을 가리키는지 확인하고 RS256 서명을 확인한다. 예시 코드는 서명, issuer, `aud`를 확인한다. 문서가 `exp`를 명시하지는 않는다(Spring `JwtDecoder` 기본 검증이 담당하는지는 이 문서 범위 밖).
- 키 회전: 「By default, Access rotates the signing key every 6 weeks.」 「Previous keys remain valid for 7 days after rotation to allow time for you to make the update.」 하드코딩하지 말고 외부 엔드포인트로 검증하며 JWT의 `kid`를 `public_certs`의 인증서와 맞춘다. 계획의 「Access JWT(RS256, owner 이메일 정확 일치)」 중 RS256·aud·JWKS는 문서와 맞다. owner 이메일 클레임(`email`)에 관한 문장은 읽은 범위에 없다(미확인).
- 계획 5번 결정(「cloudflared 제거」)은 PC 클라이언트가 호스트에서 cloudflared를 부르는 것의 제거이고, 서버 쪽 Access JWT 모드는 유지된다는 계획 문장과 이 문서가 모순되지 않는다.

## 확인하지 못한 것(요약)
1. MINA SSHD가 Windows OpenSSH와 호환된다는 공식 언급(Q1).
2. MINA SSHD의 Java 25 지원 언급. README는 Java 8+만 적는다(Q1).
3. `ClientChannel`·`KnownHostsServerKeyVerifier`의 2.20.1 소스(master만 읽음), `ChannelDirectTcpip` 사용법, `CopyMode` 값, `ClientChannelEvent` 열거값(Q1).
4. Windows OpenSSH의 SFTP 경로 형식 공식 설명(Q2).
5. Windows OpenSSH의 direct-tcpip(TCP 포워딩) 지원의 명시(Q1·Q2). 미지원 목록에 `AllowTcpForwarding`이 없다는 것까지만 확인.
6. jpackage `--launcher-as-service`의 정지·종료 처리와 `--type app-image`에서의 동작, JDK-8275062 원문(403). Commons Daemon 배포물·라이선스 페이지(Q4).
7. procrun 문서의 SCM 인터페이스 문장, `--StartMode=Java`의 종료 신호 전달(Q4).
8. Claude hooks 문서 10만~20만 자 구간의 `rewakeMessage`·`rewakeSummary` 검색, 플러그인 hook 신뢰 절차(Q6a).
9. Codex 도구·프롬프트 hook 입력의 서브에이전트 구분 필드(문서에 없음; 실측 필요)(Q6b).
10. Antigravity: 종료 코드, 서브에이전트 hook 실행 여부, 작업 디렉터리, PostToolUse JSON 예시(Q6c).
11. sqlite-jdbc의 Windows 아키텍처 열, `SQLiteOpenMode`/`mode=ro`, Java 24+ 네이티브 접근 경고(Q8).
12. Cloudflare Access JWT의 owner 이메일 클레임에 관한 문장(Q9).

## 출처 URL 목록
- https://github.com/apache/mina-sshd · https://mina.apache.org/sshd-project/downloads.html · https://mina.apache.org/sshd-project/download_2.20.1.html · https://repo1.maven.org/maven2/org/apache/sshd/sshd-core/maven-metadata.xml
- raw.githubusercontent.com/apache/mina-sshd/sshd-2.20.1/ (ClientSession.java, SftpClient.java, SftpConstants.java, SftpException.java, CoreModuleProperties.java, OpenSSHPosixRenameExtension.java, docs/sftp.md, docs/standards.md, docs/event-listeners.md), master (docs/client-setup.md, docs/port-forwarding.md, ClientChannel.java, KnownHostsServerKeyVerifier.java), github.com/apache/mina-sshd/blob/master/docs/internals.md
- https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration · …/openssh-overview · https://learn.microsoft.com/en-us/troubleshoot/windows-server/system-management-components/troubleshoot-sftp-issues-using-openssh · https://github.com/PowerShell/Win32-OpenSSH/wiki/Various-Considerations · https://raw.githubusercontent.com/PowerShell/openssh-portable/latestw_all/sftp-server.c
- https://docs.oracle.com/en/java/javase/25/docs/specs/man/jlink.html · …/jpackage.html · https://docs.oracle.com/en/java/javase/25/jpackage/packaging-overview.html
- https://commons.apache.org/proper/commons-daemon/procrun.html · https://learn.microsoft.com/en-us/windows/win32/services/service-programs · …/api/winsvc/nf-winsvc-startservicectrldispatchera · https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create
- https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html · …/systemctl.html · …/systemd.exec.html · https://docs.spring.io/spring-boot/how-to/deployment/installing.html
- https://code.claude.com/docs/en/hooks · https://learn.chatgpt.com/docs/hooks (https://developers.openai.com/codex/hooks에서 308) · https://antigravity.google/docs/hooks
- https://playwright.dev/java/docs/intro · …/browsers · …/ci · …/test-runners · https://github.com/microsoft/playwright-java
- https://github.com/xerial/sqlite-jdbc (README, USAGE.md)
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
