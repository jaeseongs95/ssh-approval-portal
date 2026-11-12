package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.SourceArguments;
import io.github.jaeseongs95.portal.app.remote.WorkingDirectory;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.SourceText;
import io.github.jaeseongs95.portal.ssh.sftp.RealServer;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * The commands of the target platforms on a real server (S3-RW-01, S3-RO-05 side, RC-B-473 and RC-B-604 to RC-B-605): what the shell of the server does with the prepared
 * line and the bytes sent as standard input. They run only through the Gradle task {@code realOpenSshTest}; nothing here was run on the machine that wrote it. The server's
 * system is data, so a test sends the commands of that system and states the same expectations: text round trip, exit code, standard error without progress records, the
 * owner's text as it was written.
 */
@Timeout(300)
class RealPlatformTest {

    private final RemoteScripts scripts = new RemoteScripts();
    private final WindowsCommandWrapper wrapper = new WindowsCommandWrapper(scripts);
    private final PythonSourceReceiver receiver = new PythonSourceReceiver(scripts, new Sha256Digester());

    private RealServer.Result run(RealServer server, PreparedCommand prepared) throws IOException {
        return server.exec(prepared.commandLine(), prepared.stdin().bytes());
    }

    private PreparedCommand command(RealServer server, String windowsText, String posixText) {
        return server.isWindows() ? wrapper.prepare(new CommandText(windowsText), new WorkingDirectory.Default())
            : new PreparedCommand(posixText, io.github.jaeseongs95.portal.app.remote.StdinBytes.none(), io.github.jaeseongs95.portal.app.remote.CommandKind.COMMAND);
    }

    /**
     * The interpreter the administrator configured for the Windows target: the product runs a Python source with it by its absolute path and never searches the PATH (the
     * receiver checks that the file exists), as 2.x did. The path comes from the Gradle property of the task; there is no default, because a guessed path is a test that
     * fails for a reason that is not the product's.
     */
    private static String windowsPython() {
        String path = System.getProperty("portal.test.openssh.windows-python");
        if (path == null || path.isBlank()) {
            throw new IllegalStateException("the system property portal.test.openssh.windows-python is not set: the realOpenSshTest task passes it for a Windows server");
        }
        return path;
    }

    @Test
    @DisplayName("S3-RW-01 RC-B-604 text with Korean letters and both kinds of quotes comes back as it was written, and the exit code and the standard error are the command's own")
    void textExitCodeAndStandardError() throws IOException {
        try (RealServer server = RealServer.open()) {
            String text = "한글 공백 'single' \"double\"";

            RealServer.Result printed = run(server, command(server, "[Console]::Write('한글 공백 ''single'' \"double\"')", "printf '%s' '한글 공백 '\\''single'\\'' \"double\"'"));
            RealServer.Result failed = run(server, command(server, "[Console]::Error.Write(\"예상 실패\"); exit 7", "printf '%s' '예상 실패' >&2; exit 7"));

            assertThat(printed.exitStatus()).isZero();
            assertThat(printed.stdout()).isEqualTo(text);
            assertThat(failed.exitStatus()).isEqualTo(7);
            assertThat(failed.stderr()).as("no CLIXML or progress record is mixed into the command's own standard error").isEqualTo("예상 실패");
        }
    }

    @Test
    @DisplayName("S3-RW-01 RC-B-605 a command of several lines with tabs reaches the shell whole")
    void multilineCommand() throws IOException {
        try (RealServer server = RealServer.open()) {
            RealServer.Result result = run(server, command(server, "$a = 'one'\n\t$b = 'two'\n[Console]::Write($a + '|' + $b)", "a=one\n\tb=two\nprintf '%s' \"$a|$b\""));

            assertThat(result.exitStatus()).isZero();
            assertThat(result.stdout()).isEqualTo("one|two");
        }
    }

    @Test
    @DisplayName("RC-B-473 RC-B-349 a Python source runs with its arguments as literal text and ends with its own exit code (needs python3, or the configured Python of a Windows server, on the account's path)")
    void pythonSource() throws IOException {
        try (RealServer server = RealServer.open()) {
            SourceText source = new SourceText("import sys\nprint(sys.argv[1] + '|' + sys.argv[2])\nsys.exit(3)\n");
            SourceArguments arguments = new SourceArguments(List.of("literal ' $(touch ignored) ; &", "한글"));
            PreparedCommand prepared = server.isWindows()
                ? receiver.prepareWindows(source, arguments, new io.github.jaeseongs95.portal.domain.target.WindowsDirectory("C:\\"),
                    new io.github.jaeseongs95.portal.domain.target.WindowsPythonExecutable(windowsPython()), false)
                : receiver.prepareLinux(source, arguments, "/", false);

            RealServer.Result result = run(server, prepared);

            assertThat(result.exitStatus()).as("stderr: %s", result.stderr()).isEqualTo(3);
            assertThat(result.stdout().strip()).isEqualTo("literal ' $(touch ignored) ; &|한글");
        }
    }
}
