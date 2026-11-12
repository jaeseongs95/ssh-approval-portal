package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.zip.GZIPInputStream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.target.WindowsDirectory;
import io.github.jaeseongs95.portal.domain.target.WindowsPythonExecutable;
import io.github.jaeseongs95.portal.domain.text.SourceText;

/**
 * The command line and the standard input of {@link PythonSourceReceiver} (S3-TP-06). The receivers are Python text sent to the target; this machine has no target,
 * so the tests read the text the way the 2.x tests read it: the structure of the command, the bytes of the input, and the order of the steps inside the receiver
 * (read through the end, check length and hash, only then decode and compile). That an incomplete, changed or extended input is refused before any effect, and that a
 * waiting input delays the run until it is closed, is a property of those steps; running them needs a real Python and is the job of the real-OpenSSH tests.
 *
 * <p>The 2.x checks of a plan object (manifest, plan digest) have no counterpart: {@link PreparedCommand} is a value. The same input gives the same command line and
 * input, and a changed input changes the line or the input.
 */
class PythonSourceReceiverTest {

    private static final String WINDOWS_PREFIX = "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command \"";
    private static final Pattern PACKED = Pattern.compile("FromBase64String\\('([A-Za-z0-9+/=]+)'\\)");
    private static final Pattern FILE_NAME = Pattern.compile("\\$s\\.FileName=\\[Text\\.Encoding\\]::UTF8\\.GetString\\(\\[Convert\\]::FromBase64String\\('([A-Za-z0-9+/=]+)'\\)\\)");
    private static final String PYTHON = "C:\\Program Files\\Python\\python.exe";

    private final RemoteScripts scripts = new RemoteScripts();
    private final PythonSourceReceiver receiver = new PythonSourceReceiver(scripts, new Sha256Digester());

    // ================================================================= POSIX target

    @Test
    @DisplayName("RC-B-352 POSIX 명령은 모든 낱말을 작은따옴표로 감싸고 내부 작은따옴표를 '\\'' 로 바꾸며 stdin은 원문 UTF-8이다")
    void posixCommandQuotesEveryWordAndSendsTheSourceAsStdin() {
        String source = "pass\n";
        PreparedCommand command = receiver.prepareLinux(new SourceText(source), args("a'b", "$(id); &"), "/", false);

        List<String> words = List.of("/usr/bin/python3", "-I", "-B", "-S", "-X", "utf8", "-c", scripts.text(RemoteScript.PYTHON_RECEIVER_POSIX), "5",
            sha256(source.getBytes(StandardCharsets.UTF_8)), "/", "a'b", "$(id); &");
        assertThat(command.commandLine()).isEqualTo(words.stream().map(PythonSourceReceiverTest::quoted).collect(Collectors.joining(" ")));
        assertThat(command.commandLine()).contains("'a'\\''b'").contains("'$(id); &'");
        assertThat(command.commandLine().length()).isLessThanOrEqualTo(2000);
        assertThat(command.kind()).isEqualTo(CommandKind.SOURCE);
        assertThat(command.stdin().bytes()).isEqualTo(source.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("RC-B-352 elevate가 참이면 'sudo' '-n' '--' '/usr/bin/python3' 로 시작하고 거짓이면 인터프리터로 시작한다")
    void elevationPutsSudoFirst() {
        SourceText source = new SourceText("pass\n");
        assertThat(receiver.prepareLinux(source, SourceArguments.none(), "/", true).commandLine()).startsWith("'sudo' '-n' '--' '/usr/bin/python3' '-I'");
        assertThat(receiver.prepareLinux(source, SourceArguments.none(), "/", false).commandLine()).startsWith("'/usr/bin/python3' '-I' '-B' '-S' '-X' 'utf8' '-c' ");
    }

    @Test
    @DisplayName("RC-B-352 한글·이모지 원문은 UTF-8 바이트 그대로 stdin이 되고 길이 인수는 문자 수가 아니라 바이트 수다. 16384바이트 원문도 받는다")
    void sourceBytesAreUtf8AndMaximumIsAccepted() {
        String text = "print('한글 😀')\r\n# 끝";
        PreparedCommand command = receiver.prepareLinux(new SourceText(text), SourceArguments.none(), "/", false);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        assertThat(command.stdin().bytes()).isEqualTo(bytes);
        assertThat(command.commandLine()).contains("'" + bytes.length + "' '" + sha256(bytes) + "' '/'");

        String maximum = "x".repeat(SourceText.MAX_BYTES);
        PreparedCommand big = receiver.prepareLinux(new SourceText(maximum), SourceArguments.none(), "/", false);
        assertThat(big.stdin().length()).isEqualTo(16384);
        assertThat(big.commandLine()).contains("'16384'");
        assertThat(big.commandLine().length()).isLessThanOrEqualTo(2000);
    }

    @Test
    @DisplayName("RC-B-352 인자 거절: 17개·513바이트(한글 171자)·CR·LF·짝 없는 서로게이트. 512바이트(한글 170자+2)·16개 경계는 받는다")
    void posixArgumentLimits() {
        SourceText source = new SourceText("pass\n");
        assertRefused(() -> receiver.prepareLinux(source, new SourceArguments(Collections.nCopies(17, "x")), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("x".repeat(513)), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("가".repeat(171)), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("a\nb"), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("a\rb"), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("\uD800"), "/", false));
        assertThat(receiver.prepareLinux(source, args("x".repeat(512)), "/", false).commandLine().length()).isLessThanOrEqualTo(2000);
        assertThat(receiver.prepareLinux(source, args("가".repeat(170) + "ab"), "/", false).commandLine().length()).isLessThanOrEqualTo(2000);
        assertThat(receiver.prepareLinux(source, new SourceArguments(Collections.nCopies(16, "x")), "/", false).commandLine().length()).isLessThanOrEqualTo(2000);
    }

    @Test
    @DisplayName("RC-B-352 작업 폴더 거절: 상대 경로·빈 값·줄바꿈·제어 문자·513바이트. 512바이트 절대 경로는 받는다")
    void posixDirectoryLimits() {
        SourceText source = new SourceText("pass\n");
        for (String bad : List.of("relative", "", "x/y", "/x\ny", "/x\ry", "/x\u0001y", "/x\0y", "/" + "a".repeat(512), "/\uD800")) {
            assertRefused(() -> receiver.prepareLinux(source, SourceArguments.none(), bad, false));
        }
        String longest = "/" + "a".repeat(511);
        assertThat(longest.getBytes(StandardCharsets.UTF_8)).hasSize(512);
        assertThat(receiver.prepareLinux(source, SourceArguments.none(), longest, false).commandLine()).contains("'" + longest + "'");
    }

    @Test
    @DisplayName("RC-B-352 명령 줄 2000자 경계: 한 글자 더 넘으면 INVALID_OPERATION_INPUT(인자 512바이트 3개도 거절)")
    void posixCommandLineLimitIsExact() {
        SourceText source = new SourceText("pass\n");
        int base = receiver.prepareLinux(source, SourceArguments.none(), "/", false).commandLine().length();
        // a second argument of m characters after one of 512 characters: the line grows by 1 + (512 + 2) and by 1 + (m + 2)
        int fit = 2000 - base - (1 + 512 + 2) - (1 + 2);
        assertThat(fit).as("the arguments leave room for a second argument of 1 to 512 characters").isBetween(1, 512);
        PreparedCommand atLimit = receiver.prepareLinux(source, args("x".repeat(512), "y".repeat(fit)), "/", false);
        assertThat(atLimit.commandLine()).hasSize(2000);
        assertRefused(() -> receiver.prepareLinux(source, args("x".repeat(512), "y".repeat(fit + 1)), "/", false));
        assertRefused(() -> receiver.prepareLinux(source, args("x".repeat(512), "x".repeat(512), "x".repeat(512)), "/", false));
    }

    @Test
    @DisplayName("S3-TP-06 POSIX 수신기: 끝까지 읽고 → 길이·해시 검사(125) → 환경 → UTF-8 해석·compile·chdir(126) → 실행 순서이며 오류 본문을 쓰지 않는다")
    void posixReceiverStepsAreInTheSafeOrder() {
        String text = scripts.text(RemoteScript.PYTHON_RECEIVER_POSIX);
        List<String> steps = List.of("n=int(sys.argv[1])", "if not 0<n<=" + SourceText.MAX_BYTES + ": sys.exit(125)", "b=sys.stdin.buffer.read(n+1)",
            "if len(b)!=n or hashlib.sha256(b).hexdigest()!=sys.argv[2]: sys.exit(125)", "os.environ.clear()", "s=b.decode('utf-8','strict')", "c=compile(s,",
            "os.chdir(sys.argv[3])", "sys.exit(126)", "exec(c,m.__dict__)");
        assertInOrder(text, steps);
        assertThat(text).contains("sys.stderr.write('Source compilation or working directory rejected\\n')").doesNotContain("traceback").doesNotContain("print_exc");
        assertThat(text).contains("sys.argv=['<ssh-python-source-v1>',*sys.argv[4:]]").contains("m=types.ModuleType('__main__')").contains("m.__package__=None")
            .contains("m.__spec__=None").contains("sys.modules['__main__']=m");
        assertThat(text).contains("os.environ.update({'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PATH':'/usr/bin:/bin'})");
    }

    @Test
    @DisplayName("S3-TP-06 같은 입력은 같은 명령 줄·stdin을 내고, 원문·인자·폴더·승격이 달라지면 명령 줄 또는 stdin이 달라진다")
    void posixSameInputSameOutputAndAnyChangeShowsUp() {
        SourceText source = new SourceText("print('private-source-marker')\n");
        PreparedCommand base = receiver.prepareLinux(source, args("literal"), "/", false);
        assertThat(receiver.prepareLinux(source, args("literal"), "/", false)).isEqualTo(base);
        assertThat(base.commandLine()).as("the source is not in the command line").doesNotContain("private-source-marker");

        assertThat(receiver.prepareLinux(new SourceText(source.value() + "\n"), args("literal"), "/", false)).isNotEqualTo(base);
        assertThat(receiver.prepareLinux(source, args("other"), "/", false).commandLine()).isNotEqualTo(base.commandLine());
        assertThat(receiver.prepareLinux(source, args("literal"), "/tmp", false).commandLine()).isNotEqualTo(base.commandLine());
        assertThat(receiver.prepareLinux(source, args("literal"), "/", true).commandLine()).isNotEqualTo(base.commandLine());
        assertThat(receiver.prepareLinux(new SourceText("print('private-source-marker')\r\n"), args("literal"), "/", false).stdin()).isNotEqualTo(base.stdin());
    }

    // ================================================================= Windows target

    @Test
    @DisplayName("RC-B-595 Windows: stdin은 프레임(헤더 바이트 수, 줄바꿈, JSON 헤더, 원문)이고 헤더는 JSON.stringify와 같은 바이트다")
    void windowsFrameHasTheHeaderAndTheSourceBytes() {
        String source = "print('한글 source stays on stdin')\r\n";
        List<String> argv = List.of("a\"b", "한글", "C:\\tail\\", "a'b", "$(ignored); &");
        PreparedCommand command = windows(source, argv, "C:\\", PYTHON, false);
        byte[] sourceBytes = source.getBytes(StandardCharsets.UTF_8);

        assertThat(command.kind()).isEqualTo(CommandKind.SOURCE);
        assertThat(headerOf(command)).isEqualTo("{\"sourceBytes\":" + sourceBytes.length + ",\"sourceSha256\":\"" + sha256(sourceBytes) + "\","
            + "\"argv\":[\"a\\\"b\",\"한글\",\"C:\\\\tail\\\\\",\"a'b\",\"$(ignored); &\"],\"cwd\":\"C:\\\\\",\"elevate\":false}");
        assertThat(sourceOf(command)).isEqualTo(sourceBytes);
        byte[] frame = command.stdin().bytes();
        String firstLine = new String(frame, 0, indexOfNewline(frame), StandardCharsets.US_ASCII);
        assertThat(Integer.parseInt(firstLine)).isEqualTo(headerOf(command).getBytes(StandardCharsets.UTF_8).length);
    }

    @Test
    @DisplayName("RC-B-595 Windows 명령 줄은 powershell.exe ... -Command \"& (...)\" 이고 부트스트랩에 \" $ ` % CR LF가 없으며 8000자 이하다")
    void windowsCommandLineShape() {
        PreparedCommand command = windows("print('x')\n", List.of("a\"b", "$(ignored); &"), "C:\\", PYTHON, false);
        String line = command.commandLine();
        assertThat(line).matches("powershell\\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command \"& \\(.+\\)\"");
        assertThat(bootstrapOf(command)).doesNotContainPattern("[\"$`%\\r\\n]");
        assertThat(line.length()).isLessThanOrEqualTo(8000);
    }

    @Test
    @DisplayName("RC-B-596 launcher: 원문·인자·폴더 비노출, 바이트 단위 복사, finally에서 Close, 상승 요청 없음, 인터프리터는 base64 복원식")
    void windowsLauncherCopiesBytesAndHidesUserData() throws IOException {
        String source = "print('한글 source stays on stdin')\r\n";
        PreparedCommand command = windows(source, List.of("a\"b", "한글", "C:\\tail\\", "$(ignored); &"), "C:\\work folder", PYTHON, false);
        String launcher = launcherOf(command);

        assertThat(launcher).doesNotContain("source stays on stdin").doesNotContain("ignored").doesNotContain("tail").doesNotContain("work folder").doesNotContain("한글");
        assertThat(launcher).doesNotContainPattern("StandardInput\\.(?:Write|WriteLine)\\s*\\(");
        assertThat(launcher).contains("$i=$p.StandardInput.BaseStream;$b=[byte[]]::new(8192);try{while(($n=[SshApproval.Stdin]::Read($b,0,$b.Length)) -gt 0){$i.Write($b,0,$n)}}")
            .contains("finally{$i.Close()}");
        assertThat(launcher).doesNotContainPattern("Console\\]::OpenStandardInput|ConsoleStream").doesNotContain("StandardInput.Close()").doesNotContainPattern("RunAs|Verb|sudo");
        assertThat(launcher).contains(scripts.line(RemoteScript.WINDOWS_STDIN_READER));
        Matcher fileName = FILE_NAME.matcher(launcher);
        assertThat(fileName.find()).isTrue();
        assertThat(new String(Base64.getDecoder().decode(fileName.group(1)), StandardCharsets.UTF_8)).isEqualTo(PYTHON);
        assertThat(launcher).contains("$s.Arguments='");
    }

    @Test
    @DisplayName("RC-B-596 launcher 인수 문자열은 고정 수신기와 프레임의 길이·SHA-256뿐이다(CreateProcess 인용, 작은따옴표 두 배)")
    void windowsLauncherArgumentsAreTheFixedReceiverAndTheFrameDigest() throws IOException {
        PreparedCommand command = windows("print('x')\n", List.of("secret-arg"), "C:\\secret-dir", PYTHON, false);
        String launcher = launcherOf(command);
        int start = launcher.indexOf("$s.Arguments='") + "$s.Arguments='".length();
        int end = launcher.indexOf("';if(-not [IO.File]::Exists($s.FileName))", start);
        assertThat(start).isPositive();
        assertThat(end).isGreaterThan(start);
        String arguments = launcher.substring(start, end).replace("''", "'");

        byte[] frame = command.stdin().bytes();
        assertThat(arguments).isEqualTo("\"-I\" \"-B\" \"-S\" \"-X\" \"utf8\" \"-c\" \"" + scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS) + "\" \"" + frame.length + "\" \"" + sha256(frame) + "\"");
        assertThat(arguments).doesNotContain("secret-arg").doesNotContain("secret-dir");
    }

    @Test
    @DisplayName("RC-B-596 곡선 따옴표·calc.exe 인자와 곡선 따옴표 경로는 launcher 평문에 없고 인터프리터는 base64 복원식이다")
    void curlyQuotesNeverReachTheLauncherText() throws IOException {
        String interpreter = "C:\\\u2018\u2019\u201c\u201d\\python.exe";
        PreparedCommand command = windows("pass\n", List.of("\u2018\u2019\u201c\u201d", "\u2019; calc.exe; }catch{};#"), "C:\\\u2018\u2019\u201c\u201d", interpreter, false);
        String launcher = launcherOf(command);
        assertThat(launcher).doesNotContainPattern("[\u2018\u2019\u201c\u201d]").doesNotContain("calc.exe");
        Matcher fileName = FILE_NAME.matcher(launcher);
        assertThat(fileName.find()).isTrue();
        assertThat(new String(Base64.getDecoder().decode(fileName.group(1)), StandardCharsets.UTF_8)).isEqualTo(interpreter);
        assertThat(headerOf(command)).contains("\u2019; calc.exe; }catch{};#");
    }

    @Test
    @DisplayName("RC-B-596 elevate: 헤더가 \"elevate\":true이고 수신기가 compile 앞에서 IsUserAnAdmin을 검사하며 launcher는 상승을 요청하지 않는다")
    void windowsElevationIsAnAdministratorTokenCheckInTheReceiver() throws IOException {
        PreparedCommand command = windows("pass\n", List.of(), "C:\\", PYTHON, true);
        assertThat(headerOf(command)).endsWith("\"elevate\":true}");
        assertThat(launcherOf(command)).doesNotContainPattern("RunAs|Verb|sudo");
        String text = scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS);
        assertThat(text).contains("if v['elevate']:\n import ctypes\n if not ctypes.windll.shell32.IsUserAnAdmin():\n");
        assertThat(text.indexOf("IsUserAnAdmin()")).isPositive().isLessThan(text.indexOf("c=compile("));
    }

    @Test
    @DisplayName("RC-B-595 hostedtoolcache 인터프리터 경로 2종(역슬래시·슬래시)을 받는다")
    void hostedToolCachePathsAreAccepted() throws IOException {
        for (String path : List.of("C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe", "C:/hostedtoolcache/windows/Python/3.13.9/x64/python.exe")) {
            Matcher fileName = FILE_NAME.matcher(launcherOf(windows("pass\n", List.of(), "C:\\", path, false)));
            assertThat(fileName.find()).isTrue();
            assertThat(new String(Base64.getDecoder().decode(fileName.group(1)), StandardCharsets.UTF_8)).isEqualTo(path);
        }
    }

    @Test
    @DisplayName("RC-B-598 Windows 경계: 원문 16384바이트, 인자 JSON 정확히 4096바이트(elevate 포함), 512바이트 경로·폴더 동시 최대도 시작 명령 8000자 이하")
    void windowsBoundaries() {
        PreparedCommand big = windows("x".repeat(SourceText.MAX_BYTES), List.of(), "C:\\", PYTHON, false);
        assertThat(headerOf(big)).contains("\"sourceBytes\":16384");
        assertThat(sourceOf(big)).hasSize(16384);

        List<String> maximumArgv = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            maximumArgv.add("x".repeat(i == 7 ? 508 : 509));
        }
        assertThat(jsonLength(maximumArgv)).isEqualTo(4096);
        assertThat(windows("pass", maximumArgv, "C:\\", PYTHON, false).commandLine().length()).isLessThanOrEqualTo(8000);
        assertThat(windows("pass", maximumArgv, "C:\\", PYTHON, true).commandLine().length()).isLessThanOrEqualTo(8000);
        List<String> oneMore = new ArrayList<>(maximumArgv);
        oneMore.set(7, oneMore.get(7) + "x");
        assertThat(jsonLength(oneMore)).isEqualTo(4097);
        assertRefused(() -> windows("pass", oneMore, "C:\\", PYTHON, false));

        String longestPython = "C:\\" + "p".repeat(498) + "\\python.exe";
        String longestCwd = "C:\\" + "w".repeat(509);
        assertThat(longestPython.getBytes(StandardCharsets.UTF_8)).hasSize(512);
        assertThat(longestCwd.getBytes(StandardCharsets.UTF_8)).hasSize(512);
        PreparedCommand extreme = windows("x".repeat(SourceText.MAX_BYTES), maximumArgv, longestCwd, longestPython, true);
        assertThat(extreme.commandLine().length()).isLessThanOrEqualTo(8000);
        assertThat(extreme.stdin().length()).as("the frame fits the receiver's limit").isLessThanOrEqualTo(SourceText.MAX_BYTES + 8192);
        assertThat(headerOf(extreme).getBytes(StandardCharsets.UTF_8).length).as("the header fits the receiver's limit").isLessThanOrEqualTo(8192);
    }

    @Test
    @DisplayName("RC-B-597 Windows 인자 거절: 17개·513바이트·CR·LF·짝 없는 서로게이트·512바이트 8개(JSON 4096 초과)")
    void windowsArgumentRefusals() {
        assertRefused(() -> windows("pass", Collections.nCopies(17, "x"), "C:\\", PYTHON, false));
        assertRefused(() -> windows("pass", List.of("x".repeat(513)), "C:\\", PYTHON, false));
        assertRefused(() -> windows("pass", List.of("\n"), "C:\\", PYTHON, false));
        assertRefused(() -> windows("pass", List.of("a\rb"), "C:\\", PYTHON, false));
        assertRefused(() -> windows("pass", List.of("\uD800"), "C:\\", PYTHON, false));
        assertRefused(() -> windows("pass", Collections.nCopies(8, "x".repeat(512)), "C:\\", PYTHON, false));
    }

    @Test
    @DisplayName("S3-TP-06 Windows 수신기: 프레임을 끝까지 읽고 → 길이·해시(125) → 헤더 해석·원문 길이·해시(125) → 관리자 확인(126) → compile·chdir(126) → 실행")
    void windowsReceiverStepsAreInTheSafeOrder() {
        String text = scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS);
        List<String> steps = List.of("n=int(sys.argv[1])", "if not 0<n<=" + (SourceText.MAX_BYTES + 8192) + ": sys.exit(125)", "b=sys.stdin.buffer.read(n+1)",
            "if len(b)!=n or hashlib.sha256(b).hexdigest()!=sys.argv[2]: sys.exit(125)", "p=b.index(b'\\n')+1", "if not 0<h<=8192: raise ValueError()", "v=json.loads(",
            "if not 0<len(b)<=" + SourceText.MAX_BYTES + " or len(b)!=v['sourceBytes'] or hashlib.sha256(b).hexdigest()!=v['sourceSha256']: raise ValueError()",
            "except Exception: sys.exit(125)", "if v['elevate']:", "IsUserAnAdmin()", "sys.exit(126)", "c=compile(b.decode('utf-8','strict')", "os.chdir(v['cwd'])",
            "sys.argv=['<ssh-python-source-v1>',*v['argv']]", "exec(c,m.__dict__)");
        assertInOrder(text, steps);
        assertThat(text).contains("sys.stderr.write('Source compilation or cwd rejected\\n')").doesNotContain("print_exc");
    }

    @Test
    @DisplayName("S3-TP-06 수신기가 정한 환경과 환경 리비전의 정책 문장이 같은 이름들을 가진다")
    void environmentPolicyMatchesTheReceivers() {
        String posix = scripts.text(RemoteScript.PYTHON_RECEIVER_POSIX);
        assertThat(posix).contains("'LANG':'C.UTF-8'").contains("'LC_ALL':'C.UTF-8'").contains("'PATH':'/usr/bin:/bin'");
        assertThat(receiver.linuxEnvironmentRevision().hex()).isEqualTo(sha256("{\"LANG\":\"C.UTF-8\",\"LC_ALL\":\"C.UTF-8\",\"PATH\":\"/usr/bin:/bin\"}".getBytes(StandardCharsets.UTF_8)));

        String windowsText = scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS);
        List<String> inherited = List.of("SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA");
        assertThat(windowsText).contains("keys=" + inherited.stream().map(name -> "'" + name + "'").collect(Collectors.joining(",")));
        assertThat(windowsText).contains("env['PATH']=os.path.dirname(sys.executable)+';'+root+'\\\\System32;'+root");
        String policy = "{\"inherit\":[" + inherited.stream().map(name -> "\"" + name + "\"").collect(Collectors.joining(","))
            + "],\"path\":\"interpreter-directory;SystemRoot\\\\System32;SystemRoot\"}";
        assertThat(receiver.windowsEnvironmentRevision().hex()).isEqualTo(sha256(policy.getBytes(StandardCharsets.UTF_8)));
        assertThat(receiver.windowsEnvironmentRevision()).isNotEqualTo(receiver.linuxEnvironmentRevision());
    }

    @Test
    @DisplayName("S3-TP-06 수신기 최대 바이트 상수는 SourceText.MAX_BYTES(16384)와 같다")
    void receiverLimitsFollowTheSourceTextLimit() {
        assertThat(SourceText.MAX_BYTES).isEqualTo(16384);
        assertThat(scripts.text(RemoteScript.PYTHON_RECEIVER_POSIX)).contains("0<n<=16384");
        assertThat(scripts.text(RemoteScript.PYTHON_RECEIVER_WINDOWS)).contains("0<n<=24576").contains("0<len(b)<=16384");
    }

    @Test
    @DisplayName("S3-TP-06 Windows도 같은 입력은 같은 명령 줄·stdin을 내고 원문·인자·폴더·인터프리터·승격이 달라지면 명령 줄 또는 stdin이 달라진다")
    void windowsSameInputSameOutputAndAnyChangeShowsUp() {
        PreparedCommand base = windows("print(1)\n", List.of("a"), "C:\\work", PYTHON, false);
        assertThat(windows("print(1)\n", List.of("a"), "C:\\work", PYTHON, false)).isEqualTo(base);

        // the line holds the hash of the frame, so another frame is another line as well as another input
        for (PreparedCommand changed : List.of(windows("print(1)\n\n", List.of("a"), "C:\\work", PYTHON, false), windows("print(2)\n", List.of("a"), "C:\\work", PYTHON, false),
            windows("print(1)\n", List.of("b"), "C:\\work", PYTHON, false), windows("print(1)\n", List.of("a"), "C:\\Temp", PYTHON, false),
            windows("print(1)\n", List.of("a"), "C:\\work", PYTHON, true))) {
            assertThat(changed.stdin()).isNotEqualTo(base.stdin());
            assertThat(changed.commandLine()).isNotEqualTo(base.commandLine());
        }
        PreparedCommand otherInterpreter = windows("print(1)\n", List.of("a"), "C:\\work", "D:\\Runtime\\python.exe", false);
        assertThat(otherInterpreter.stdin()).as("the interpreter is not in the frame").isEqualTo(base.stdin());
        assertThat(otherInterpreter.commandLine()).isNotEqualTo(base.commandLine());
    }

    // ================================================================= helpers

    private PreparedCommand windows(String source, List<String> argv, String cwd, String interpreter, boolean elevate) {
        return receiver.prepareWindows(new SourceText(source), new SourceArguments(argv), new WindowsDirectory(cwd), new WindowsPythonExecutable(interpreter), elevate);
    }

    private static SourceArguments args(String... values) {
        return new SourceArguments(List.of(values));
    }

    private static void assertRefused(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RequestRefusedException.class, e -> {
            assertThat(e.code()).isEqualTo(RequestErrorCode.INVALID_OPERATION_INPUT);
            assertThat(e.attempt()).isEqualTo(ExecutionAttempt.NOT_ATTEMPTED);
        });
    }

    private static void assertInOrder(String text, List<String> steps) {
        int from = 0;
        for (String step : steps) {
            int at = text.indexOf(step, from);
            assertThat(at).as("step '%s' after position %d", step, from).isGreaterThanOrEqualTo(0);
            from = at + step.length();
        }
    }

    private static String quoted(String word) {
        return "'" + word.replace("'", "'\\''") + "'";
    }

    /** The length in UTF-8 bytes of the JSON array of the arguments, written by the rule of {@code JSON.stringify} for plain text (quote and backslash escaped). */
    private static int jsonLength(List<String> values) {
        String json = values.stream().map(value -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"").collect(Collectors.joining(",", "[", "]"));
        return json.getBytes(StandardCharsets.UTF_8).length;
    }

    private static int indexOfNewline(byte[] bytes) {
        int index = 0;
        while (bytes[index] != '\n') {
            index++;
        }
        return index;
    }

    /** The JSON header of the frame the Windows command sends as standard input. */
    private static String headerOf(PreparedCommand command) {
        byte[] frame = command.stdin().bytes();
        int newline = indexOfNewline(frame);
        int length = Integer.parseInt(new String(frame, 0, newline, StandardCharsets.US_ASCII));
        return new String(frame, newline + 1, length, StandardCharsets.UTF_8);
    }

    /** The source bytes at the end of the frame. */
    private static byte[] sourceOf(PreparedCommand command) {
        byte[] frame = command.stdin().bytes();
        int newline = indexOfNewline(frame);
        int length = Integer.parseInt(new String(frame, 0, newline, StandardCharsets.US_ASCII));
        return Arrays.copyOfRange(frame, newline + 1 + length, frame.length);
    }

    /** The text inside the double quotes of {@code -Command "..."}. */
    private static String bootstrapOf(PreparedCommand command) {
        String line = command.commandLine();
        assertThat(line).startsWith(WINDOWS_PREFIX).endsWith("\"");
        return line.substring(WINDOWS_PREFIX.length(), line.length() - 1);
    }

    /** The launcher the bootstrap unpacks. */
    private static String launcherOf(PreparedCommand command) throws IOException {
        Matcher packed = PACKED.matcher(bootstrapOf(command));
        assertThat(packed.find()).as("the bootstrap holds a base64 gzip text").isTrue();
        try (GZIPInputStream gunzip = new GZIPInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(packed.group(1))))) {
            return new String(gunzip.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("Every Java platform has SHA-256", e);
        }
    }
}
