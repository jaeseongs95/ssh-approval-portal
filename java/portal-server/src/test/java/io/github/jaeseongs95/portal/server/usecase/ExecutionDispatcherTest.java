package io.github.jaeseongs95.portal.server.usecase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.operation.OperationIntake;
import io.github.jaeseongs95.portal.app.operation.OperationsService;
import io.github.jaeseongs95.portal.app.output.FormatSpan;
import io.github.jaeseongs95.portal.app.output.OutputFormat;
import io.github.jaeseongs95.portal.app.output.OutputManifest;
import io.github.jaeseongs95.portal.app.output.OutputManifestStore;
import io.github.jaeseongs95.portal.app.output.OutputPayloadStore;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.PhaseMark;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.AuditState;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.store.journal.JdbcExecutionTimelineStore;

/**
 * The dispatcher with the real journal, claim store, output stores and use case beans over the embedded H2 database; only the SSH executor, the audit port and the
 * target platform are plain test classes (stage 3 design 8.5: S3-UC-01, S3-UC-02 extended, S3-SS-09, S3-EX-03, S3-EX-09; cases B-193, B-194, B-196, B-241, A-468, A-471).
 */
@UseCaseTest
class ExecutionDispatcherTest {

    private static final StartAuthority OWNER = new StartAuthority.Owner();

    private final OperationIntake intake;
    private final OperationsService operations;
    private final OperationJournal journal;
    private final ScriptedExecutor executor;
    private final RecordingAudit audit;
    private final FixedTargets targets;
    private final UseCaseKit kit;
    private final RecordingTerminalListener listener;
    private final JdbcExecutionTimelineStore timelines;
    private final OutputManifestStore manifests;
    private final OutputPayloadStore payloads;

    ExecutionDispatcherTest(OperationIntake intake, OperationsService operations, OperationJournal journal, ScriptedExecutor executor, RecordingAudit audit,
                            FixedTargets targets, UseCaseKit kit, RecordingTerminalListener listener, JdbcExecutionTimelineStore timelines,
                            OutputManifestStore manifests, OutputPayloadStore payloads) {
        this.intake = intake;
        this.operations = operations;
        this.journal = journal;
        this.executor = executor;
        this.audit = audit;
        this.targets = targets;
        this.kit = kit;
        this.listener = listener;
        this.timelines = timelines;
        this.manifests = manifests;
        this.payloads = payloads;
    }

    @BeforeEach
    void start() {
        executor.reset();
        audit.failNothing();
        targets.reset();
    }

    private Operation submitApproved(String text) {
        Operation submitted = intake.submit(kit.command(text));
        intake.approve(submitted.id(), OWNER);
        return submitted;
    }

    private static RecordedResult resultOf(Operation operation) {
        return ((Settlement.Settled) operation.settlement()).result();
    }

    @Test
    @DisplayName("S3-UC-01 an approved command is claimed, runs exactly once and completes; the states, the audit lines, the output and the notification are each written once")
    void anApprovedCommandRunsOnceAndCompletes() throws Exception {
        Operation submitted = intake.submit(kit.command("echo hello"));
        assertThat(submitted.state()).isEqualTo(OperationState.PENDING);
        intake.approve(submitted.id(), OWNER);
        OperationId id = submitted.id();

        Operation done = kit.awaitTerminal(id);

        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(executor.sentLines()).containsExactly("echo hello");
        assertThat(journal.events(id).stream().map(OperationEvent::state).toList()).containsSubsequence(OperationState.PENDING, OperationState.QUEUED, OperationState.STARTING,
            OperationState.RUNNING, OperationState.COMPLETED);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(audit.actionsOf(id)).containsExactly(AuditAction.SUBMITTED, AuditAction.EXECUTION_QUEUED, AuditAction.APPROVED, AuditAction.COMPLETED);
            assertThat(listener.timesTold(id)).isEqualTo(1);
        });
        OutputManifest manifest = manifests.inState(io.github.jaeseongs95.portal.app.output.OutputState.READY).stream().filter(m -> m.binding().executionId().equals(id))
            .findFirst().orElseThrow();
        assertThat(readText(manifest)).isEqualTo("ok\n");
    }

    @Test
    @DisplayName("S3-SS-05 the times of the phases of the execution are stored with the result: connected, request sent, closed")
    void theTimelineIsStored() throws Exception {
        Operation submitted = submitApproved("echo timeline");
        kit.awaitTerminal(submitted.id());
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(timelines.timelineOf(submitted.id()).marks().stream().map(PhaseMark::phase).toList())
            .containsExactly(ExecutionPhase.CONNECTED, ExecutionPhase.REQUEST_SENT, ExecutionPhase.CLOSED));
    }

    @Test
    @DisplayName("S3-UC-01 a command that exits with 1 is failed, not completed, and ran once")
    void aFailingCommandIsFailed() throws Exception {
        executor.when("exit-one", executor.exits(1));
        Operation submitted = submitApproved("exit-one");
        Operation done = kit.awaitTerminal(submitted.id());
        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(resultOf(done)).isInstanceOf(RecordedResult.Executed.class);
        assertThat(executor.requestsSent()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SS-09 a target that changed while the connection was made is refused by the guard before the request: failed with TARGET_CHANGED at TARGET_GUARD, nothing sent")
    void theGuardRefusesAChangedTarget() throws Exception {
        executor.when("slow-connect", (request, sink, control) -> {
            targets.change("Web changed while connecting");
            control.guard().beforeDispatch();
            throw new AssertionError("The guard let a changed target through");
        });
        Operation submitted = submitApproved("slow-connect");
        Operation done = kit.awaitTerminal(submitted.id());
        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(resultOf(done)).isEqualTo(new RecordedResult.Refused(DispatchFailure.refused(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD)));
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("S3-UC-02 RC-A-468 a start audit that does not become durable stops the operation with StepFailed(START_AUDIT, AUDIT_FAILED) before the first byte is sent")
    void aFailedStartAuditSendsNothing() throws Exception {
        audit.failOn(AuditAction.APPROVED);
        Operation submitted = submitApproved("echo never-sent");
        Operation done = kit.awaitTerminal(submitted.id());
        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(resultOf(done)).isEqualTo(new RecordedResult.Refused(DispatchFailure.stepFailed(DispatchStage.START_AUDIT, DispatchReason.AUDIT_FAILED)));
        assertThat(executor.requestsSent()).isZero();
        assertThat(audit.actionsOf(submitted.id())).doesNotContain(AuditAction.APPROVED);
    }

    @Test
    @DisplayName("S3-UC-02 RC-A-471 a final audit that does not become durable changes nothing of the result: the operation stays completed, is marked, ran once, and is announced once")
    void aFailedFinalAuditLeavesTheOutcome() throws Exception {
        audit.failOn(AuditAction.COMPLETED);
        Operation submitted = submitApproved("echo audited");
        OperationId id = submitted.id();
        Operation done = kit.awaitTerminal(id);
        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(kit.find(id).audit()).isEqualTo(AuditState.FAILED));
        Operation marked = kit.find(id);
        assertThat(marked.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(resultOf(marked)).isInstanceOf(RecordedResult.Executed.class);
        assertThat(executor.requestsSent()).isEqualTo(1);
        assertThat(listener.timesTold(id)).isEqualTo(1);
        assertThat(audit.actionsOf(id)).doesNotContain(AuditAction.COMPLETED);
    }

    @Test
    @DisplayName("RC-B-194 RC-B-241 a cancel of a running operation is TERMINATING at once, asks the execution to stop, and the state is CANCELLED only when the executor has settled; nothing is submitted in its place")
    void aCancelOfARunningOperationIsTerminatingUntilSettled() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        executor.when("long-running", executor.blocksUntilCancelled(started));
        Operation submitted = submitApproved("long-running");
        assertThat(started.await(10, TimeUnit.SECONDS)).isTrue();
        assertThat(kit.find(submitted.id()).state()).isEqualTo(OperationState.RUNNING);

        Operation cancelling = operations.cancel(submitted.id());

        assertThat(cancelling.state()).isEqualTo(OperationState.TERMINATING);
        Operation done = kit.awaitTerminal(submitted.id());
        assertThat(done.state()).isEqualTo(OperationState.CANCELLED);
        assertThat(executor.sentLines()).containsExactly("long-running");
    }

    @Test
    @DisplayName("RC-B-193 RC-B-196 a queued operation is cancelled without starting, one whose deadline passes expires while the running ones go on, and nothing but the running ones was sent")
    void queuedOperationsAreCancelledOrExpiredWhileTheRunningOnesGoOn() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        executor.when("blocker", executor.blocksUntil(release));
        Operation first = submitApproved("blocker one");
        Operation second = submitApproved("blocker two");
        kit.await(first.id(), operation -> operation.state() == OperationState.RUNNING);
        kit.await(second.id(), operation -> operation.state() == OperationState.RUNNING);

        Operation third = intake.submit(kit.command("third waits"));
        intake.approve(third.id(), OWNER);
        assertThat(kit.find(third.id()).state()).isEqualTo(OperationState.QUEUED);
        Operation expiring = intake.submit(kit.command("expiring waits", new Deadline.At(Instant.now().plusMillis(800))));
        intake.approve(expiring.id(), OWNER);

        assertThat(kit.awaitTerminal(expiring.id()).state()).isEqualTo(OperationState.EXPIRED);
        assertThat(operations.cancel(third.id()).state()).isEqualTo(OperationState.CANCELLED);
        assertThat(kit.find(first.id()).state()).isEqualTo(OperationState.RUNNING);
        assertThat(kit.find(second.id()).state()).isEqualTo(OperationState.RUNNING);

        release.countDown();
        kit.awaitTerminal(first.id());
        kit.awaitTerminal(second.id());
        assertThat(executor.sentLines()).containsExactlyInAnyOrder("blocker one", "blocker two");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(audit.actionsOf(expiring.id())).contains(AuditAction.EXPIRED));
    }

    @Test
    @DisplayName("S3-EX-09 a runner that fails after the request was sent leaves an unknown result that has to be reconciled, is not sent again, and the next operation runs")
    void anUnexpectedFailureIsUnknownAndNeverReplayed() throws Exception {
        executor.when("explodes", executor.failsUnexpectedly());
        Operation exploded = submitApproved("explodes");
        Operation done = kit.awaitTerminal(exploded.id());
        assertThat(done.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(((Settlement.Settled) done.settlement()).reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertThat(executor.requestsSent()).isEqualTo(1);

        Operation next = submitApproved("echo after");
        assertThat(kit.awaitTerminal(next.id()).state()).isEqualTo(OperationState.COMPLETED);
        assertThat(executor.sentLines()).containsExactly("explodes", "echo after");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(audit.actionsOf(exploded.id())).contains(AuditAction.UNKNOWN));
        assertThat(audit.all()).noneMatch(event -> event.note().contains("SECRET-TRANSPORT-CONTENT"));
    }

    @Test
    @DisplayName("S3-TP-04 a command that the platform cannot take is refused before dispatch: failed with INVALID_COMMAND at COMMAND_VALIDATION, nothing sent")
    void aPlatformRefusalIsAFailureBeforeDispatch() throws Exception {
        Operation submitted = submitApproved("echo " + TestPlatform.TOO_LARGE);
        Operation done = kit.awaitTerminal(submitted.id());
        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(resultOf(done)).isEqualTo(new RecordedResult.Refused(DispatchFailure.refused(DispatchReason.INVALID_COMMAND, DispatchStage.COMMAND_VALIDATION)));
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("S3-EX-13 the output is redacted as a whole when it is rendered: a secret that spans two frames does not appear in the stored text")
    void theOutputIsRedactedAsAWhole() throws Exception {
        executor.when("leaky", executor.exits(0, "key AKIAABCDEFGH", "IJKLMNOP end\n"));
        Operation submitted = submitApproved("leaky");
        kit.awaitTerminal(submitted.id());
        OutputManifest manifest = manifests.inState(io.github.jaeseongs95.portal.app.output.OutputState.READY).stream()
            .filter(m -> m.binding().executionId().equals(submitted.id())).findFirst().orElseThrow();
        String text = readText(manifest);
        assertThat(text).doesNotContain("AKIAABCDEFGHIJKLMNOP").contains("key").contains("end");
    }

    private String readText(OutputManifest manifest) throws IOException {
        FormatSpan span = manifest.formats().spans().get(OutputFormat.TEXT);
        try (PayloadRead read = payloads.openFormat(manifest.id(), OutputFormat.TEXT, span)) {
            return new String(Channels.newInputStream(read.channel()).readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
