package io.github.jaeseongs95.portal.ssh.exec;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.CommandKind;
import io.github.jaeseongs95.portal.app.remote.ExecReply;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.PhaseMark;
import io.github.jaeseongs95.portal.app.remote.PreparedCommand;
import io.github.jaeseongs95.portal.app.remote.StdinBytes;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.Truncation;
import io.github.jaeseongs95.portal.domain.operation.TimeoutMs;
import io.github.jaeseongs95.portal.ssh.testkit.AdapterFixture;
import io.github.jaeseongs95.portal.ssh.testkit.CollectingSink;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ReceivedSignal;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.apache.sshd.server.Signal;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.util.unit.DataSize;

/**
 * Cases S3-EX-01 .. S3-EX-14 of docs/migration/stage3-design.md (8.5), with the vendor cases they stand for (RC-B-481 .. RC-B-491, RC-A-483) and the cases of defect
 * D-0038 rewritten for decision D3-08 (RC-B-475 .. RC-B-477): the real {@link MinaRemoteExecutor}, session pool and MINA client against the MINA test server.
 */
@Timeout(120)
class MinaRemoteExecutorTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final String ALIAS = "main";
    private static final Duration WAIT = Duration.ofSeconds(30);

    private EmbeddedSshServer server;
    private AdapterFixture adapter;

    @AfterEach
    void stop() throws IOException {
        if (adapter != null) {
            adapter.close();
        }
        if (server != null) {
            server.close();
        }
    }

    private EmbeddedSshServer.Builder serverBuilder() {
        return EmbeddedSshServer.builder().password(USER, PASSWORD);
    }

    /** Starts the server and an adapter whose profile {@code main} points at it. */
    private void startAll(EmbeddedSshServer.Builder builder) throws IOException {
        server = builder.start();
        adapter = AdapterFixture.start(AdapterFixture.defaultSettings());
        adapter.profiles().put(ALIAS, AdapterFixture.profileFor(server, USER));
        adapter.credentials().password(ALIAS, PASSWORD);
    }

    private static ExecutionLimits limits(long deadlineMillis, long graceMillis) {
        return new ExecutionLimits(Duration.ofMillis(deadlineMillis), Duration.ofMillis(graceMillis), DataSize.ofMegabytes(1));
    }

    private ExecutionReport run(String command, ExecutionLimits limits, ExecReply reply, CollectingSink sink) {
        return adapter.executor().run(AdapterFixture.execution(ALIAS, command, limits, reply), sink, AdapterFixture.control());
    }

    private ExecutionReport run(String command) {
        return run(command, ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, CollectingSink.accepting());
    }

    private CompletableFuture<ExecutionReport> runAsync(String command, ExecutionLimits limits, ExecReply reply, CollectingSink sink, CancelSource cancel) {
        return CompletableFuture.supplyAsync(() -> adapter.executor().run(AdapterFixture.execution(ALIAS, command, limits, reply), sink, AdapterFixture.control(cancel)),
            adapter.async());
    }

    private static List<ExecutionPhase> phases(ExecutionReport report) {
        return report.timeline().marks().stream().map(PhaseMark::phase).toList();
    }

    private static ExecutionFailure.Classified classified(ExecutionOutcome outcome) {
        assertThat(outcome.failure()).isInstanceOf(ExecutionFailure.Classified.class);
        return (ExecutionFailure.Classified) outcome.failure();
    }

    @Test
    @DisplayName("S3-EX-01 an exit 0 command: stdout, EXITED, CommandExited(0), COMPLETED, and the seven timeline marks in order")
    void aCommandThatExits() throws Exception {
        startAll(serverBuilder().script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        CollectingSink sink = CollectingSink.accepting();
        ExecutionReport report = run("echo ok", ExecutionLimits.defaults(), ExecReply.AWAITED, sink);
        ExecutionOutcome outcome = report.outcome();
        assertThat(sink.stdout()).isEqualTo("ok\n");
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.EXIT);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.EXITED);
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(0));
        assertThat(outcome.evidence()).isEqualTo(new CompletionEvidence.CommandExited(0));
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.COMPLETE);
        assertThat(outcome.outputState()).isEqualTo(OutputState.COMPLETE);
        assertThat(outcome.capture()).isEqualTo(CaptureState.OK);
        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(phases(report)).containsExactly(ExecutionPhase.CONNECT_STARTED, ExecutionPhase.CONNECTED, ExecutionPhase.CHANNEL_OPENED, ExecutionPhase.REQUEST_SENT,
            ExecutionPhase.FIRST_OUTPUT, ExecutionPhase.EXIT_SEEN, ExecutionPhase.CLOSED);
        List<Instant> instants = report.timeline().marks().stream().map(PhaseMark::at).toList();
        for (int i = 1; i < instants.size(); i++) {
            assertThat(instants.get(i)).isAfterOrEqualTo(instants.get(i - 1));
        }
        assertThat(server.execRequestCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-01 a non-zero exit is FAILED with the code, and stderr is kept apart from stdout")
    void aNonZeroExit() throws Exception {
        startAll(serverBuilder().script("fail 3", ScriptedCommand.exits(3, "", "boom\n")));
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = run("fail 3", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, sink).outcome();
        assertThat(sink.stdout()).isEmpty();
        assertThat(sink.stderr()).isEqualTo("boom\n");
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(3));
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.EXITED);
        assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
    }

    @Test
    @DisplayName("S3-EX-02 / RC-B-482 the deadline: the partial output is kept, INT, TERM and KILL are requested in order, and without an exit the result is UNKNOWN with the time limit reported")
    void theDeadline() throws Exception {
        startAll(serverBuilder().script("hang", ScriptedCommand.printsThenHangs("before")));
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = run("hang", limits(1000, 600), ExecReply.NOT_AWAITED, sink).outcome();
        assertThat(sink.stdout()).isEqualTo("before");
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.DEADLINE);
        assertThat(outcome.timeout()).isEqualTo(new TimeoutMs.After(1000));
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertThat(outcome.signalDelivery()).isEqualTo(SignalDelivery.REQUESTED);
        assertThat(outcome.outputState()).isEqualTo(OutputState.PARTIAL);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
        assertThat(server.receivedSignals().await(3, WAIT)).extracting(ReceivedSignal::signal).containsExactly(Signal.INT, Signal.TERM, Signal.KILL);
        assertThat(server.destroyedCommands().await(1, WAIT)).containsExactly("hang");
    }

    @Test
    @DisplayName("S3-EX-03 / RC-B-483 b a cancel before the run starts: nothing is dispatched and the server accepts no connection")
    void aCancelBeforeConnecting() throws Exception {
        startAll(serverBuilder());
        CancelSource cancel = new CancelSource();
        cancel.cancel();
        ExecutionReport report = adapter.executor().run(AdapterFixture.execution(ALIAS, "echo ok", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED), CollectingSink.accepting(),
            AdapterFixture.control(cancel));
        assertThat(report.outcome().reason()).isEqualTo(ExecutionReason.CANCEL);
        assertThat(report.outcome().remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(report.outcome().verdict()).isEqualTo(OperationState.CANCELLED);
        assertThat(report.timeline().marks()).isEmpty();
        assertThat(server.acceptedConnections().size()).isZero();
        assertThat(server.execRequestCount()).isZero();
    }

    @Test
    @DisplayName("S3-EX-04 / RC-B-483 a the cancel of a command that ignores signals: INT, TERM, KILL in order, SignalDelivery REQUESTED, and no exit evidence means UNKNOWN, not CANCELLED")
    void aCancelWithoutEvidence() throws Exception {
        startAll(serverBuilder().script("hang", ScriptedCommand.printsThenHangs("failure detail")));
        CancelSource cancel = new CancelSource();
        CollectingSink sink = CollectingSink.accepting();
        CompletableFuture<ExecutionReport> running = runAsync("hang", limits(60_000, 600), ExecReply.NOT_AWAITED, sink, cancel);
        server.startedCommands().await(1, WAIT);
        cancel.cancel();
        ExecutionOutcome outcome = running.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.CANCEL);
        assertThat(sink.stdout()).isEqualTo("failure detail");
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.INCOMPLETE);
        assertThat(outcome.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertThat(outcome.signalDelivery()).isEqualTo(SignalDelivery.REQUESTED);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
        assertThat(server.receivedSignals().await(3, WAIT)).extracting(ReceivedSignal::signal).containsExactly(Signal.INT, Signal.TERM, Signal.KILL);
    }

    @Test
    @DisplayName("S3-EX-04 / RC-B-484 a command that ends on INT: the cancel sends INT after the input was closed, the exit status is the evidence, and the result is CANCELLED")
    void aCancelWithEvidence() throws Exception {
        startAll(serverBuilder().script("dies on INT", ScriptedCommand.endsOnSignal(Signal.INT, 130)));
        CancelSource cancel = new CancelSource();
        CompletableFuture<ExecutionReport> running = runAsync("dies on INT", limits(60_000, 3000), ExecReply.NOT_AWAITED, CollectingSink.accepting(), cancel);
        server.startedCommands().await(1, WAIT);
        cancel.cancel();
        ExecutionOutcome outcome = running.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.CANCEL);
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(130));
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.EXITED);
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.COMPLETE);
        assertThat(outcome.signalDelivery()).isEqualTo(SignalDelivery.REQUESTED);
        assertThat(outcome.verdict()).isEqualTo(OperationState.CANCELLED);
        assertThat(server.receivedSignals().snapshot()).extracting(ReceivedSignal::signal).startsWith(Signal.INT);
    }

    @Test
    @DisplayName("S3-EX-05 / RC-B-489 a sink that fails on the second frame: capture FAILED, output PARTIAL, the channel is emptied to its end, and the next command on the same session works")
    void aSinkThatFails() throws Exception {
        startAll(serverBuilder().script("big", ScriptedCommand.emitsBytes(100_000, 0, 0)).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        CollectingSink sink = CollectingSink.failingFromFrame(2);
        ExecutionOutcome outcome = run("big", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, sink).outcome();
        assertThat(outcome.capture()).isEqualTo(CaptureState.FAILED);
        assertThat(outcome.outputState()).isEqualTo(OutputState.PARTIAL);
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(0));
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.COMPLETE);
        assertThat(classified(outcome).stage()).isEqualTo(ExecutionStage.OUTPUT_CAPTURE);
        assertThat(classified(outcome).code()).isEqualTo(ExecutionErrorCode.OUTPUT_CAPTURE_FAILED);
        StreamCapture.Captured stdout = (StreamCapture.Captured) outcome.stdout();
        assertThat(stdout.receivedBytes()).as("every byte was read although the sink failed").isEqualTo(100_000);
        assertThat(stdout.retainedBytes()).isLessThan(100_000).isPositive();
        ExecutionOutcome next = run("echo ok").outcome();
        assertThat(next.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).as("the same session served both commands").isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-06 / RC-B-488 the output cap is per stream: 2 MiB on stdout is cut at 1 MiB and counted, stderr below the cap is whole")
    void theOutputCap() throws Exception {
        startAll(serverBuilder().script("big", ScriptedCommand.emitsBytes(2L * 1024 * 1024, 300_000, 0)));
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = run("big", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, sink).outcome();
        StreamCapture.Captured stdout = (StreamCapture.Captured) outcome.stdout();
        StreamCapture.Captured stderr = (StreamCapture.Captured) outcome.stderr();
        assertThat(stdout.receivedBytes()).isEqualTo(2L * 1024 * 1024);
        assertThat(stdout.retainedBytes()).isEqualTo(1024L * 1024);
        assertThat(stdout.truncation()).isEqualTo(Truncation.TRUNCATED);
        assertThat(stderr.receivedBytes()).isEqualTo(300_000);
        assertThat(stderr.retainedBytes()).isEqualTo(300_000);
        assertThat(stderr.truncation()).isEqualTo(Truncation.COMPLETE);
        assertThat(sink.stdoutBytes()).hasSize(1024 * 1024);
        assertThat(sink.stderrBytes()).hasSize(300_000);
        assertThat(outcome.outputState()).isEqualTo(OutputState.PARTIAL);
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(0));
    }

    @Test
    @DisplayName("S3-EX-07 a command that ends on a signal: ExitStatus.Signaled with the name, FAILED")
    void anExitSignal() throws Exception {
        startAll(serverBuilder().script("killed", ScriptedCommand.endsWithSignal("TERM")));
        ExecutionOutcome outcome = run("killed").outcome();
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Signaled("TERM"));
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.EXITED);
        assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
    }

    @Test
    @DisplayName("S3-EX-08 / RC-B-490 a failure while writing the standard input is INPUT_FAILED while the session lives, and the run is settled after the channel is gone")
    void aFailedInput() throws Exception {
        startAll(serverBuilder().script("hang", ScriptedCommand.closesChannel()));
        PreparedCommand command = new PreparedCommand("hang", new StdinBytes(new byte[16 * 1024 * 1024]), CommandKind.SOURCE);
        CompletableFuture<ExecutionReport> running = CompletableFuture.supplyAsync(
            () -> adapter.executor().run(AdapterFixture.execution(ALIAS, command, limits(60_000, 600), ExecReply.NOT_AWAITED), CollectingSink.accepting(), AdapterFixture.control()),
            adapter.async());
        ExecutionOutcome outcome = running.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.INPUT_FAILED);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
        assertThat(run("echo ok").outcome().exit()).as("the session survived: the input failed, not the transport").isInstanceOf(ExitStatus.Exited.class);
        assertThat(server.acceptedConnections().size()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-08 / D-0038 when the session is lost while the input is being written, the cause is the lost transport, not the failed write: TRANSPORT_LOST wins over INPUT_FAILED")
    void aLostSessionWinsOverAFailedInput() throws Exception {
        startAll(serverBuilder().script("hang", ScriptedCommand.hangs()));
        PreparedCommand command = new PreparedCommand("hang", new StdinBytes(new byte[16 * 1024 * 1024]), CommandKind.SOURCE);
        CompletableFuture<ExecutionReport> running = CompletableFuture.supplyAsync(
            () -> adapter.executor().run(AdapterFixture.execution(ALIAS, command, limits(60_000, 600), ExecReply.NOT_AWAITED), CollectingSink.accepting(), AdapterFixture.control()),
            adapter.async());
        server.startedCommands().await(1, WAIT);
        assertThat(server.dropConnections()).isEqualTo(1);
        ExecutionOutcome outcome = running.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
    }

    @Test
    @DisplayName("S3-EX-08 / RC-B-491 the standard input of a source command reaches the command, and the end of the input is sent")
    void theStandardInputIsDelivered() throws Exception {
        startAll(serverBuilder().script("python3 -", ScriptedCommand.echoesInput(0)));
        PreparedCommand command = new PreparedCommand("python3 -", new StdinBytes("print('ok')\n".getBytes(StandardCharsets.UTF_8)), CommandKind.SOURCE);
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = adapter.executor().run(AdapterFixture.execution(ALIAS, command, ExecutionLimits.defaults(), ExecReply.NOT_AWAITED), sink, AdapterFixture.control())
            .outcome();
        assertThat(sink.stdout()).isEqualTo("print('ok')\n");
        assertThat(outcome.exit()).isEqualTo(new ExitStatus.Exited(0));
    }

    @Test
    @DisplayName("S3-EX-09 no resend: the connection is cut when the exec request arrives; the result is UNKNOWN, the server got the request exactly once, and only a separate request uses a new session")
    void aRequestIsNeverSentAgain() throws Exception {
        startAll(serverBuilder().script("boom", ScriptedCommand.dropsConnection()).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        ExecutionOutcome outcome = run("boom", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, CollectingSink.accepting()).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
        assertThat(server.execRequests().snapshot()).containsExactly("boom");
        ExecutionOutcome next = run("echo ok").outcome();
        assertThat(next.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.execRequests().snapshot()).as("the lost request was not sent again").containsExactly("boom", "echo ok");
        assertThat(server.acceptedConnections().size()).as("a new session for the next request").isEqualTo(2);
    }

    @Test
    @DisplayName("S3-EX-10 / RC-B-475 the server refuses a channel: NOT_STARTED with SSH_CHANNEL_OPEN_FAILED, one attempt, the session lives and the next command runs on it")
    void aRefusedChannelOpen() throws Exception {
        startAll(serverBuilder().script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        server.refuseNewChannels(true);
        ExecutionOutcome refused = run("echo ok").outcome();
        assertThat(refused.reason()).isEqualTo(ExecutionReason.CHANNEL_OPEN_FAILED);
        assertThat(refused.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(classified(refused).stage()).isEqualTo(ExecutionStage.SSH_CHANNEL);
        assertThat(classified(refused).code()).isEqualTo(ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED);
        assertThat(classified(refused).remoteOutcome()).isEqualTo(RemoteOutcome.NOT_STARTED);
        assertThat(server.execRequests().snapshot()).as("the refused open never reached the exec request").containsExactly("echo ok");
        server.refuseNewChannels(false);
        ExecutionOutcome next = run("echo ok").outcome();
        assertThat(next.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).as("the refusal did not cost the session").isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-10 / RC-B-476 a refused open, a non-zero exit and a zero exit in a row never replace the session")
    void refusalsAndFailuresKeepTheSession() throws Exception {
        startAll(serverBuilder().script("exit 7", ScriptedCommand.exits(7, "", "")).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        server.refuseNewChannels(true);
        assertThat(run("echo ok").outcome().remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        server.refuseNewChannels(false);
        assertThat(run("exit 7").outcome().exit()).isEqualTo(new ExitStatus.Exited(7));
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-10 / RC-B-477 (decision D3-08) a command that is running is not touched by a refused open on its session, and no special rule blocks the next command after it")
    void aRunningCommandSurvivesARefusedOpen() throws Exception {
        startAll(serverBuilder().script("work", ScriptedCommand.printsThenHangs("started")).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        CancelSource cancelWork = new CancelSource();
        CollectingSink workSink = CollectingSink.accepting();
        CompletableFuture<ExecutionReport> working = runAsync("work", limits(60_000, 300), ExecReply.NOT_AWAITED, workSink, cancelWork);
        server.startedCommands().await(1, WAIT);
        server.refuseNewChannels(true);
        assertThat(run("echo ok").outcome().reason()).isEqualTo(ExecutionReason.CHANNEL_OPEN_FAILED);
        server.refuseNewChannels(false);
        assertThat(working.isDone()).as("the running command was not stopped by the refusal").isFalse();
        assertThat(server.destroyedCommands().snapshot()).isEmpty();
        cancelWork.cancel();
        working.get(WAIT.toSeconds(), TimeUnit.SECONDS);
        assertThat(run("echo ok").outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EX-11 / RC-B-486 the server cuts the connection while the command runs: transport lost, UNKNOWN, reconciliation required, the bytes read so far are kept")
    void aTransportLostWhileRunning() throws Exception {
        startAll(serverBuilder().script("hang", ScriptedCommand.printsThenHangs("before")).script("echo ok", ScriptedCommand.exits(0, "ok\n", "")));
        CollectingSink sink = CollectingSink.accepting();
        CompletableFuture<ExecutionReport> running = runAsync("hang", limits(60_000, 600), ExecReply.NOT_AWAITED, sink, new CancelSource());
        server.startedCommands().await(1, WAIT);
        sink.offeredFrames().await(1, WAIT); // the bytes written before the cut have reached the sink
        assertThat(server.dropConnections()).isEqualTo(1);
        ExecutionOutcome outcome = running.get(WAIT.toSeconds(), TimeUnit.SECONDS).outcome();
        assertThat(outcome.reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
        assertThat(outcome.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(outcome.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertThat(outcome.cleanup()).isEqualTo(CleanupState.COMPLETE);
        assertThat(outcome.verdict()).isEqualTo(OperationState.UNKNOWN);
        assertThat(classified(outcome).stage()).isEqualTo(ExecutionStage.SSH_EXECUTION);
        assertThat(classified(outcome).remoteOutcome()).isEqualTo(RemoteOutcome.UNKNOWN);
        assertThat(sink.stdout()).isEqualTo("before");
        assertThat(run("echo ok").outcome().verdict()).as("the next request gets a new session").isEqualTo(OperationState.COMPLETED);
        assertThat(server.acceptedConnections().size()).isEqualTo(2);
    }

    @Test
    @DisplayName("S3-EX-12 the exec reply boundary (P4/P5): a FAILURE reply is NOT_STARTED, a connection cut before the reply is UNKNOWN, and without the reply a refusal is not told from silence")
    void theExecReplyBoundary() throws Exception {
        startAll(serverBuilder().script("refused", ScriptedCommand.refused()).script("boom", ScriptedCommand.dropsConnection()));
        ExecutionOutcome refused = run("refused", ExecutionLimits.defaults(), ExecReply.AWAITED, CollectingSink.accepting()).outcome();
        assertThat(refused.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(classified(refused).stage()).isEqualTo(ExecutionStage.SSH_EXECUTION);
        assertThat(classified(refused).code()).isEqualTo(ExecutionErrorCode.SSH_EXECUTION_FAILED);
        assertThat(classified(refused).remoteOutcome()).isEqualTo(RemoteOutcome.NOT_STARTED);
        assertThat(refused.verdict()).isEqualTo(OperationState.FAILED);

        ExecutionOutcome cut = run("boom", ExecutionLimits.defaults(), ExecReply.AWAITED, CollectingSink.accepting()).outcome();
        assertThat(cut.reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
        assertThat(cut.remoteState()).isEqualTo(RemoteState.UNKNOWN);
        assertThat(cut.verdict()).isEqualTo(OperationState.UNKNOWN);

        ExecutionOutcome silent = run("refused", limits(1000, 300), ExecReply.NOT_AWAITED, CollectingSink.accepting()).outcome();
        assertThat(silent.reason()).as("no reply was asked for: the refusal looks like a command that never ends").isEqualTo(ExecutionReason.DEADLINE);
        assertThat(silent.remoteState()).isEqualTo(RemoteState.UNKNOWN);
    }

    @Test
    @DisplayName("S3-EX-13 / RC-B-481 a multibyte character cut between two packets is kept as bytes and is whole when the bytes are decoded together")
    void aMultibyteCharacterCutBetweenFrames() throws Exception {
        byte[] text = "가🙂".getBytes(StandardCharsets.UTF_8);
        byte[] first = java.util.Arrays.copyOfRange(text, 0, 2);
        byte[] second = java.util.Arrays.copyOfRange(text, 2, text.length);
        startAll(serverBuilder().script("utf8", ScriptedCommand.emitsChunks(List.of(first, second), 0)));
        CollectingSink sink = CollectingSink.accepting();
        ExecutionOutcome outcome = run("utf8", ExecutionLimits.defaults(), ExecReply.NOT_AWAITED, sink).outcome();
        assertThat(sink.stdoutBytes()).isEqualTo(text);
        assertThat(sink.stdout()).isEqualTo("가🙂");
        assertThat(((StreamCapture.Captured) outcome.stdout()).receivedBytes()).isEqualTo(text.length);
        assertThat(outcome.outputState()).isEqualTo(OutputState.COMPLETE);
    }

    @Test
    @DisplayName("S3-EX-14 / RC-A-483 a command of 32768 bytes reaches the server whole, in ASCII and in multibyte text; 32769 is refused by CommandText (use case, not here)")
    void aCommandOf32KiB() throws Exception {
        String ascii = "printf " + "x".repeat(32768 - "printf ".length());
        String multibyte = "printf " + "가".repeat(10920) + "1";
        assertThat(ascii.getBytes(StandardCharsets.UTF_8)).hasSize(32768);
        assertThat(multibyte.getBytes(StandardCharsets.UTF_8)).hasSize(32768);
        startAll(serverBuilder().script(ascii, ScriptedCommand.exits(0, "", "")).script(multibyte, ScriptedCommand.exits(0, "", "")));
        assertThat(run(ascii).outcome().exit()).isEqualTo(new ExitStatus.Exited(0));
        assertThat(run(multibyte).outcome().exit()).isEqualTo(new ExitStatus.Exited(0));
        assertThat(server.execRequests().snapshot()).containsExactly(ascii, multibyte);
    }
}
