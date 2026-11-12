package io.github.jaeseongs95.portal.ssh.platform;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.ssh.sftp.HiddenLinkProbe;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The probe for the links that a Windows SFTP server does not show (S3-RW-04): what it sends and how it reads the end of the command. What the command does on a real
 * Windows server is shown by the real-server test; here the executor is a plain class that ends the command as the test says and keeps what it was sent.
 */
class WindowsReparseProbeTest {

    private static final RemoteTarget TARGET = new RemoteTarget(new TargetId("windows"), TargetRevision.of("a".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);
    private static final WindowsRemotePath PATH = new WindowsRemotePath("C:\\work\\linkdir\\x.bin");

    /** Ends every command the way the test says; keeps the standard input and the command line of each. */
    private static final class Executor implements RemoteExecutor {
        private final ExecutionOutcome outcome;
        private final List<String> stdins = new ArrayList<>();
        private final List<String> commandLines = new ArrayList<>();

        Executor(ExecutionOutcome outcome) {
            this.outcome = outcome;
        }

        @Override
        public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
            stdins.add(new String(request.command().stdin().bytes(), StandardCharsets.UTF_8));
            commandLines.add(request.command().commandLine());
            return new ExecutionReport(outcome, ExecutionTimeline.empty());
        }
    }

    private static HiddenLinkProbe.Verdict check(Executor executor) {
        WindowsReparseProbe probe = new WindowsReparseProbe(new WindowsCommandWrapper(new RemoteScripts()), executor);
        return probe.check(TARGET, PATH, TransferLimits.defaults(), new ExecutionControl(new CancelSource(), () -> { }));
    }

    @Test
    @DisplayName("S3-RW-04 only a Windows path is looked at")
    void appliesToWindowsPathsOnly() {
        WindowsReparseProbe probe = new WindowsReparseProbe(new WindowsCommandWrapper(new RemoteScripts()), new Executor(ExecutionOutcome.exited(0, List.of())));

        assertThat(probe.applies(PATH)).isTrue();
        assertThat(probe.applies(new PosixRemotePath("/home/user/x.bin"))).isFalse();
    }

    @Test
    @DisplayName("S3-RW-04 the path travels as base64 inside the script and never as text; the command line is the fixed PowerShell line, sent once")
    void pathIsData() {
        Executor executor = new Executor(ExecutionOutcome.exited(0, List.of()));

        check(executor);

        assertThat(executor.stdins).hasSize(1);
        String script = executor.stdins.get(0);
        assertThat(script).contains(Base64.getEncoder().encodeToString(PATH.value().getBytes(StandardCharsets.UTF_8)));
        assertThat(script).doesNotContain("linkdir").doesNotContain("x.bin");
        assertThat(script).contains("ReparsePoint").contains("GetAttributes");
        assertThat(executor.commandLines.get(0)).doesNotContain("linkdir");
    }

    @Test
    @DisplayName("S3-RW-04 the end of the command is the answer: 0 clear, 3 linked, any other code is not an answer")
    void exitCodes() {
        assertThat(check(new Executor(ExecutionOutcome.exited(0, List.of())))).isEqualTo(new HiddenLinkProbe.Clear());
        assertThat(check(new Executor(ExecutionOutcome.exited(3, List.of())))).isEqualTo(new HiddenLinkProbe.Linked());
        assertThat(check(new Executor(ExecutionOutcome.exited(1, List.of())))).isEqualTo(new HiddenLinkProbe.Unverified());
        assertThat(check(new Executor(ExecutionOutcome.exited(255, List.of())))).isEqualTo(new HiddenLinkProbe.Unverified());
    }

    @Test
    @DisplayName("S3-RW-04 the exit code of a component that could not be looked at (access denied, I/O error) is not Clear and not Linked: it is Unverified")
    void unreadableComponentIsUnverified() {
        assertThat(check(new Executor(ExecutionOutcome.exited(4, List.of())))).isEqualTo(new HiddenLinkProbe.Unverified());
    }

    @Test
    @DisplayName("S3-RW-04 the script stops the walk with 0 only for a component that is not there, never for any error; every other error ends with 4; a path without a drive form ends with 4")
    void scriptFailsClosed() {
        Executor executor = new Executor(ExecutionOutcome.exited(0, List.of()));

        check(executor);

        String script = executor.stdins.get(0);
        assertThat(script).as("no catch that stops the walk for every exception").doesNotContain("catch{break}").doesNotContain("catch {break}");
        assertThat(script).contains("catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{break}");
        assertThat(script.split("break", -1)).as("one break in the whole script").hasSize(2);
        assertThat(script).contains("catch{exit 4}");
        assertThat(script).contains("-notmatch '^[A-Za-z]:\\\\.'){exit 4}");
    }

    @Test
    @DisplayName("S3-RW-04 a command that did not start or whose end was not seen is NotRun with the reason, never Clear")
    void commandThatDidNotEnd() {
        assertThat(check(new Executor(ExecutionOutcome.notDispatched(ExecutionReason.CHANNEL_OPEN_FAILED, List.of()))))
            .isEqualTo(new HiddenLinkProbe.NotRun(TransferFailureCause.CHANNEL_OPEN_FAILED));
        ExecutionFailure lost = new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN);
        assertThat(check(new Executor(ExecutionOutcome.transportLost(lost, List.of())))).isEqualTo(new HiddenLinkProbe.NotRun(TransferFailureCause.TRANSPORT_LOST));
    }
}
