package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Random;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.text.CommandText;

/**
 * The Windows PowerShell command line of {@link WindowsCommandWrapper} (S3-TP-04, S3-TP-05). The tests read the text the target would receive: the line is
 * {@code powershell.exe ... -EncodedCommand <base64 of UTF-16LE>}, and a user command's script is a gzip receiver that is unpacked here. The structural claims are
 * about the text, as in the 2.x tests; whether PowerShell accepts the text is the job of the Windows runs of the real-OpenSSH tests.
 *
 * <p>The 2.x checks of a plan object that was changed on the way (the manifest and the plan digest) have no counterpart: {@link PreparedCommand} is a value. Instead
 * the same input must give the same line and input, and a changed input must change the line or the input.
 */
class WindowsCommandWrapperTest {

    private static final String ENCODED = " -EncodedCommand ";
    private static final Pattern PACKED = Pattern.compile("FromBase64String\\('([A-Za-z0-9+/=]+)'\\)");
    private static final Pattern WORKDIR_DATA = Pattern.compile(
        "\\$workdir=\\[Text\\.UTF8Encoding\\]::new\\(\\$false,\\$true\\)\\.GetString\\(\\[Convert\\]::FromBase64String\\('([A-Za-z0-9+/=]+)'\\)\\)");
    private static final String CLIXML_PROGRESS =
        "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><Obj S=\"progress\" RefId=\"0\"><MS><PR N=\"Record\" /></MS></Obj></Objs>";

    private final RemoteScripts scripts = new RemoteScripts();
    private final WindowsCommandWrapper wrapper = new WindowsCommandWrapper(scripts);

    // ---------------------------------------------------------------- RC-B-558

    @Test
    @DisplayName("RC-B-558 직접 래퍼·수신기 부트스트랩·gzip 수신기 세 경로 모두 원 오류와 위치를 보고하고 일반 문구는 없다")
    void everyCatchPathReportsTheOriginalErrorAndPosition() throws IOException {
        String marker = "throw 'deliberate-test-error-7f3a'";
        PreparedCommand direct = wrapper.wrap(marker);
        PreparedCommand prepared = wrapper.prepare(new CommandText(marker), new WorkingDirectory.Default());
        String directScript = decodedScript(direct);
        String bootstrap = decodedScript(prepared);
        String receiver = unpack(bootstrap);

        for (String script : List.of(directScript, bootstrap, receiver)) {
            assertThat(script).contains("[Console]::Error.WriteLine($_.ToString())").contains("InvocationInfo.PositionMessage")
                .doesNotContain("WriteLine('Windows command failed')");
        }
        assertThat(prepared.stdin().bytes()).isEqualTo(marker.getBytes(StandardCharsets.UTF_8));
        assertThat(directScript).contains(marker).contains("$ProgressPreference='SilentlyContinue'");
        assertThat(receiver).contains("$ProgressPreference='SilentlyContinue'");
    }

    // ---------------------------------------------------------------- RC-B-559

    @Test
    @DisplayName("RC-B-559 진행 기록만 있는 CLIXML은 표시에서 빈 문자열이고 원문 문자열은 그대로 진행 기록을 가진다")
    void progressOnlyClixmlShowsNothing() {
        assertThat(wrapper.presentStderr(CLIXML_PROGRESS)).isEmpty();
        assertThat(CLIXML_PROGRESS).contains("progress");
    }

    @Test
    @DisplayName("RC-B-559 진행과 오류가 섞이면 오류 문구는 남고 progress는 빠지며 일반 stderr는 그대로다")
    void mixedClixmlKeepsTheErrorAndPlainStderrIsUntouched() {
        String mixed = CLIXML_PROGRESS.replace("</Objs>", "<S S=\"Error\">deliberate-test-error-7f3a</S></Objs>");
        String shown = wrapper.presentStderr(mixed);
        assertThat(shown).contains("deliberate-test-error-7f3a").doesNotContain("S=\"progress\"");
        assertThat(shown).isEqualTo("#< CLIXML\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">deliberate-test-error-7f3a</S></Objs>");
        assertThat(wrapper.presentStderr("plain stderr\n")).isEqualTo("plain stderr\n");
        assertThat(wrapper.presentStderr("")).isEmpty();
    }

    @Test
    @DisplayName("RC-B-559 진행이 아닌 CLIXML 기록은 원문 그대로 남고 $·역슬래시도 변형되지 않으며 블록 앞뒤 글은 보존된다")
    void nonProgressRecordsStayVerbatim() {
        String error = "#< CLIXML\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">cost $1 \\ ${x}</S></Objs>";
        assertThat(wrapper.presentStderr(error)).isEqualTo(error);
        assertThat(wrapper.presentStderr("before\n" + CLIXML_PROGRESS + "after")).isEqualTo("before\nafter");
        String progressString = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\"><S S='progress'>noise</S><S S=\"Error\">kept</S></Objs>";
        assertThat(wrapper.presentStderr(progressString)).isEqualTo("#< CLIXML\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">kept</S></Objs>");
    }

    // ---------------------------------------------------------------- RC-B-560

    @Test
    @DisplayName("RC-B-560 정확히 32768바이트 원문은 stdin으로 가고 수신기는 길이·해시에 결속되며 원문은 시작 명령에 없다")
    void maximumCommandTravelsAsStdinBoundToLengthAndHash() throws IOException {
        String prefix = "Write-Output '한글 😀 %PATH% !X! ` $literal'; #";
        String raw = prefix + "x".repeat(CommandText.MAX_BYTES - prefix.getBytes(StandardCharsets.UTF_8).length);
        byte[] rawBytes = raw.getBytes(StandardCharsets.UTF_8);
        assertThat(rawBytes).hasSize(32768);

        PreparedCommand plan = wrapper.prepare(new CommandText(raw), new WorkingDirectory.Default());
        String receiver = receiverOf(plan);

        assertThat(plan.kind()).isEqualTo(CommandKind.COMMAND);
        assertThat(plan.stdin().bytes()).isEqualTo(rawBytes);
        assertThat(plan.commandLine().length()).isLessThan(8000);
        assertThat(receiver).doesNotContain(raw).contains(sha256(rawBytes)).contains(scripts.line(RemoteScript.WINDOWS_STDIN_READER));
        assertThat(receiver).doesNotContainPattern("OpenStandardInput|Console\\]::In");
        assertThat(receiver).containsPattern("\\[SshApproval.Stdin\\]::Read\\(\\$buffer,\\$count,\\$buffer.Length-\\$count\\)");
        assertThat(receiver).containsPattern("CreateInstance\\(\\[byte\\],32769\\)");
        assertThat(receiver).containsPattern("\\$count -ne 32768");
        assertThat(receiver).containsPattern("\\[Text.UTF8Encoding\\]::new\\(\\$false,\\$true\\)");
        assertThat(receiver).containsPattern("Microsoft.PowerShell.Core\\\\Out-Default");
        assertThat(receiver).containsPattern("exit \\$LASTEXITCODE");
        assertThat(receiver).doesNotContainPattern("Exception\\.Message");
        assertThatThrownBy(() -> new CommandText(raw + "x")).isInstanceOf(IllegalArgumentException.class);
    }

    // ---------------------------------------------------------------- RC-B-561

    @Test
    @DisplayName("RC-B-561 stdin 읽기 조각은 실제 파이프 종료(109)만 EOF로 보고 핸들·작업 폴더·모듈 자동 로딩을 건드리지 않는다")
    void stdinReaderTreatsOnlyTheRealPipeEndAsEof() {
        String reader = scripts.line(RemoteScript.WINDOWS_STDIN_READER);
        assertThat(reader).containsPattern("new SafeFileHandle\\(GetStdHandle\\(-10\\),false\\)");
        assertThat(reader).containsPattern("ReadFile\\(SafeFileHandle h,\\[Out\\]byte\\[\\] b");
        assertThat(reader).containsPattern("bool ok=ReadFile\\([^;]+;int e=Marshal.GetLastWin32Error\\(\\);if\\(!ok\\)\\{if\\(e==109\\)return 0;throw new System\\.ComponentModel\\.Win32Exception\\(e\\);\\}if\\(r>0\\)");
        assertThat(reader).containsPattern("for\\(;;\\)");
        assertThat(reader).doesNotContainPattern("CloseHandle|\\.Dispose|PSModuleAutoLoadingPreference|SetCurrentDirectory");
        assertThat(reader).startsWith("&{$ProgressPreference='SilentlyContinue';Microsoft.PowerShell.Core\\Import-Module");
        assertThat(reader).contains("-Scope Local -Force -ErrorAction Stop").contains("$PSHOME,'Modules','Microsoft.PowerShell.Utility'");
    }

    @Test
    @DisplayName("RC-B-561 509개 작은따옴표 작업 폴더로 준비해도 시작 명령은 8000자 미만이고 stdin 읽기는 해시 앞, 길이 검사는 소스 생성 앞이다")
    void receiverReadsBeforeHashingAndChecksLengthBeforeCompiling() throws IOException {
        String raw = "Microsoft.PowerShell.Utility\\Get-Date";
        PreparedCommand plan = wrapper.prepare(new CommandText(raw), at("C:\\" + "'".repeat(509)));
        String receiver = receiverOf(plan);

        assertThat(plan.commandLine().length()).isLessThan(8000);
        assertThat(plan.stdin().bytes()).isEqualTo(raw.getBytes(StandardCharsets.UTF_8));
        assertThat(receiver.indexOf("$read=[SshApproval.Stdin]::Read")).isPositive().isLessThan(receiver.indexOf("$hash="));
        assertThat(receiver.indexOf("if($count -ne ")).isPositive().isLessThan(receiver.indexOf("$source="));
        assertThat(receiver.indexOf("$hash=")).isLessThan(receiver.indexOf("if($actual -ne "));
        assertThat(receiver.indexOf("if($actual -ne ")).isLessThan(receiver.indexOf("[ScriptBlock]::Create($source)"));
        assertThat(receiver).containsPattern("if\\(\\$read -eq 0\\)\\{break\\}");
    }

    // ---------------------------------------------------------------- RC-B-563

    @Test
    @DisplayName("RC-B-563 의사난수 512바이트 작업 폴더와 32KiB 원문·모듈 한정 명령 3종 모두 시작 명령 8000자 이하이고 폴더는 base64 데이터로만 있다")
    void variedMaximumDirectoryStaysInsideTheLimit() throws IOException {
        List<Character> alphabet = new ArrayList<>();
        for (char c = 33; c <= 126; c++) {
            if ("<>\"|?*:/\\".indexOf(c) < 0) {
                alphabet.add(c);
            }
        }
        Random random = new Random(25);
        StringBuilder directory = new StringBuilder("C:\\");
        for (int i = 0; i < 508; i++) {
            directory.append(alphabet.get(random.nextInt(alphabet.size())));
        }
        String workdir = directory.append('x').toString();
        assertThat(workdir.getBytes(StandardCharsets.UTF_8)).hasSize(512);

        String prefix = "[Console]::Write('ok');#";
        String big = prefix + "x".repeat(CommandText.MAX_BYTES - prefix.length());
        for (String command : List.of(big, "Microsoft.PowerShell.Utility\\Get-Date", "Microsoft.PowerShell.Management\\Get-Location")) {
            PreparedCommand plan = wrapper.prepare(new CommandText(command), at(workdir));
            assertThat(plan.commandLine().length()).as("line length for %s", command.substring(0, 12)).isLessThanOrEqualTo(8000);
            assertThat(plan.stdin().bytes()).isEqualTo(command.getBytes(StandardCharsets.UTF_8));
            String receiver = receiverOf(plan);
            assertThat(receiver).contains(Base64.getEncoder().encodeToString(workdir.getBytes(StandardCharsets.UTF_8))).doesNotContain(workdir);
        }
    }

    // ---------------------------------------------------------------- RC-B-564, RC-B-565

    @Test
    @DisplayName("RC-B-564 작업 폴더는 base64 데이터 복원식으로 결속되고 평문이 없으며 Set-Location·SetCurrentDirectory·읽기 전용 모듈 고정을 가진다")
    void directoryIsBoundAsDataAndReadOnlyModulesStayPinned() throws IOException {
        String workdir = "C:\\한글\\owner's files";
        String receiver = receiverOf(wrapper.prepare(new CommandText("Microsoft.PowerShell.Utility\\Get-Date"), at(workdir)));
        assertThat(receiver).contains("$workdir=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('"
            + Base64.getEncoder().encodeToString(workdir.getBytes(StandardCharsets.UTF_8)) + "'))");
        assertThat(receiver).doesNotContain(workdir);
        assertThat(receiver).contains("Set-Location -LiteralPath $workdir").contains("SetCurrentDirectory($workdir)");
        assertThat(receiver).contains("$PSHOME,'Modules','Microsoft.PowerShell.Utility'").contains("$PSModuleAutoLoadingPreference='None'");

        String normal = receiverOf(wrapper.prepare(new CommandText("whoami.exe"), at("C:\\work")));
        assertThat(normal).as("an ordinary command's directory does not change module autoloading").doesNotContain("$PSModuleAutoLoadingPreference='None'");
        assertThat(wrapper.prepare(new CommandText("whoami.exe"), at("C:\\" + "'".repeat(509))).commandLine().length()).isLessThan(8000);
    }

    @Test
    @DisplayName("RC-B-564 거부 목록 9건은 WindowsRemotePath가 거절해 래퍼에 닿지 않고, 래퍼는 POSIX 경로와 512바이트 초과 경로를 거절한다")
    void badDirectoriesNeverReachTheWrapperOrAreRefused() {
        for (String bad : List.of("C:relative", "\\\\host\\share", "/tmp", "C:\\a\\..\\b", "C:\\a:stream", "C:\\a?", "C:\\a\n", "C:\\a.", "C:\\a\"b")) {
            assertThatThrownBy(() -> new WindowsRemotePath(bad)).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        CommandText command = new CommandText("whoami.exe");
        assertThatThrownBy(() -> wrapper.prepare(command, new WorkingDirectory.At(new PosixRemotePath("/tmp/work")))).isInstanceOf(IllegalArgumentException.class);
        String tooLong = "C:\\" + "a".repeat(510);
        assertThat(tooLong.getBytes(StandardCharsets.UTF_8)).hasSize(513);
        assertThatThrownBy(() -> wrapper.prepare(command, at(tooLong))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.INVALID_OPERATION_INPUT));
    }

    @Test
    @DisplayName("RC-B-565 일반·곡선 작은따옴표와 곡선 큰따옴표가 든 작업 폴더도 코드가 아니라 데이터로 복원되고 calc.exe 평문이 없다")
    void quotesInTheDirectoryNeverBecomeCode() throws IOException {
        for (String quote : List.of("'", "\u2018", "\u2019", "\u201c", "\u201d")) {
            String workdir = "C:\\한글\\owner" + quote + "; calc.exe; # files";
            PreparedCommand plan = wrapper.prepare(new CommandText("whoami.exe"), at(workdir));
            String receiver = receiverOf(plan);
            Matcher data = WORKDIR_DATA.matcher(receiver);
            assertThat(data.find()).as("the directory is a fixed base64 restore expression").isTrue();
            assertThat(new String(Base64.getDecoder().decode(data.group(1)), StandardCharsets.UTF_8)).isEqualTo(workdir);
            assertThat(receiver).doesNotContain(workdir).doesNotContain("calc.exe");
            assertThat(new String(plan.stdin().bytes(), StandardCharsets.UTF_8)).isEqualTo("whoami.exe");
        }
    }

    // ---------------------------------------------------------------- RC-B-624, RC-B-625

    @Test
    @DisplayName("RC-B-624 한글·이모지·따옴표·%PATH%·!X!·$env:TEMP·역따옴표·exit 7 원문이 복원 스크립트에 정확히 한 번 있고 바깥 명령에는 평문이 없다")
    void wrappedSentenceKeepsTheTextAndOutsideHasNoPlainText() {
        String raw = "Write-Output '한글 😀 \"따옴표\" %PATH% !X! $env:TEMP'; Write-Output 'x`y'; exit 7";
        PreparedCommand wrapped = wrapper.wrap(raw);
        String script = decodedScript(wrapped);

        assertThat(wrapped.commandLine()).matches("powershell\\.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -InputFormat Text -OutputFormat Text -EncodedCommand [A-Za-z0-9+/=]+");
        assertThat(script.indexOf(raw)).isNotNegative().isEqualTo(script.lastIndexOf(raw));
        assertThat(wrapped.commandLine()).doesNotContain(raw);
        assertThat(script).contains("[Console]::OutputEncoding=").contains("exit $LASTEXITCODE");
        assertThat(wrapped.kind()).isEqualTo(CommandKind.COMMAND);
        assertThat(wrapped.stdin().length()).isZero();
    }

    @Test
    @DisplayName("RC-B-624 빈 문장·공백·NUL·CR·ESC·DEL·U+0085·짝 없는 서로게이트는 래퍼가 거절한다")
    void wrapRefusesHiddenOrBlankSentences() {
        for (String bad : List.of("", " ", "x\0y", "x\ry", "x\u001by", "x\u007fy", "x\u0085y", "\uD800")) {
            assertThatThrownBy(() -> wrapper.wrap(bad)).as("sentence %s", bad.length()).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    @DisplayName("RC-B-625 ASCII·한글·이모지 모두 인코딩 뒤 8000자 경계를 지키고 자르지 않으며 초과는 WINDOWS_COMMAND_TOO_LARGE다")
    void theEncodedLineBoundaryIsExactForEveryScript() {
        for (String unit : List.of("x", "가", "😀")) {
            int low = 1;
            int high = 4096;
            while (low + 1 < high) {
                int middle = (low + high) / 2;
                if (accepts(unit.repeat(middle))) {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            String raw = unit.repeat(low);
            String oneMore = unit.repeat(low + 1);
            PreparedCommand wrapped = wrapper.wrap(raw);
            assertThat(wrapped.commandLine().length()).as("longest accepted line of %s", unit).isLessThanOrEqualTo(8000).isGreaterThanOrEqualTo(7993);
            assertThat(decodedScript(wrapped)).contains(raw);
            assertThatThrownBy(() -> wrapper.wrap(oneMore)).isInstanceOfSatisfying(RequestRefusedException.class, e -> {
                assertThat(e.code()).isEqualTo(TransferErrorCode.WINDOWS_COMMAND_TOO_LARGE);
                assertThat(e.attempt()).as("refused before anything is sent").isEqualTo(ExecutionAttempt.NOT_ATTEMPTED);
                assertThat(e.retryable()).isFalse();
            });
        }
    }

    // ---------------------------------------------------------------- the two read-only modules, determinism

    @Test
    @DisplayName("RC-B-564 모듈 한정 Get-Date·Get-Location(대소문자·앞뒤 공백 무시)만 모듈 경로를 고정하고 다른 명령은 아니다")
    void onlyTheTwoQualifiedQueriesPinTheirModule() {
        String date = decodedScript(wrapper.wrap("Microsoft.PowerShell.Utility\\Get-Date"));
        assertThat(date).contains("$PSModuleAutoLoadingPreference='None'").contains("$PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'");
        String location = decodedScript(wrapper.wrap("  microsoft.powershell.management\\get-location \t"));
        assertThat(location).contains("$PSModuleAutoLoadingPreference='None'").contains("'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1'");
        assertThat(decodedScript(wrapper.wrap("whoami.exe"))).doesNotContain("PSModuleAutoLoadingPreference").doesNotContain("Import-Module");
        assertThat(decodedScript(wrapper.wrap("Microsoft.PowerShell.Utility\\Get-Date -Format yyyy"))).doesNotContain("PSModuleAutoLoadingPreference");
    }

    @Test
    @DisplayName("S3-TP-04 같은 입력은 같은 명령 줄·stdin을 내고, 원문·작업 폴더가 달라지면 명령 줄 또는 stdin이 달라진다")
    void sameInputSameOutputAndAnyChangeShowsUp() {
        PreparedCommand base = wrapper.prepare(new CommandText("whoami.exe"), at("C:\\work"));
        assertThat(wrapper.prepare(new CommandText("whoami.exe"), at("C:\\work"))).isEqualTo(base);
        assertThat(wrapper.wrap("whoami.exe")).isEqualTo(wrapper.wrap("whoami.exe"));

        PreparedCommand otherCommand = wrapper.prepare(new CommandText("whoami.exr"), at("C:\\work"));
        assertThat(otherCommand.stdin()).isNotEqualTo(base.stdin());
        assertThat(otherCommand.commandLine()).as("same length, other bytes: the receiver holds another hash").isNotEqualTo(base.commandLine());
        assertThat(wrapper.prepare(new CommandText("whoami.exe"), at("C:\\other")).commandLine()).isNotEqualTo(base.commandLine());
        assertThat(wrapper.prepare(new CommandText("whoami.exe"), new WorkingDirectory.Default()).commandLine()).isNotEqualTo(base.commandLine());
        assertThat(wrapper.prepare(new CommandText("a\r\nb"), at("C:\\work")).stdin().bytes()).as("CR LF is kept").isEqualTo("a\r\nb".getBytes(StandardCharsets.UTF_8));
    }

    // ---------------------------------------------------------------- helpers

    private static WorkingDirectory at(String windowsPath) {
        return new WorkingDirectory.At(new WindowsRemotePath(windowsPath));
    }

    private boolean accepts(String sentence) {
        try {
            wrapper.wrap(sentence);
            return true;
        } catch (RequestRefusedException e) {
            assertThat(e.code()).isEqualTo(TransferErrorCode.WINDOWS_COMMAND_TOO_LARGE);
            return false;
        }
    }

    /** The script a line carries: the base64 after {@code -EncodedCommand}, read as UTF-16LE. */
    private static String decodedScript(PreparedCommand command) {
        String line = command.commandLine();
        String encoded = line.substring(line.indexOf(ENCODED) + ENCODED.length());
        return new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_16LE);
    }

    /** The receiver text of a prepared user command: the gzip text the stub holds, unpacked. */
    private static String receiverOf(PreparedCommand command) throws IOException {
        return unpack(decodedScript(command));
    }

    private static String unpack(String stub) throws IOException {
        Matcher packed = PACKED.matcher(stub);
        assertThat(packed.find()).as("the stub holds a base64 gzip text").isTrue();
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
