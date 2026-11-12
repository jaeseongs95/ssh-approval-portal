package io.github.jaeseongs95.portal.server.usecase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.operation.ReadCommandRequest;
import io.github.jaeseongs95.portal.app.operation.ReadCommandService;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.AuditState;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The read-only command path with the real journal, scheduler and stores (stage 3 design 8.2 group G3: cases A-467 to A-469, B-356, B-358). A read command is a durable
 * operation of the read profile, started by the server's read authority, queued like every operation; a refusal never shows text of the transport.
 */
@UseCaseTest
class ReadCommandServiceTest {

    private final ReadCommandService reads;
    private final OperationJournal journal;
    private final MaintenanceStore maintenance;
    private final ScriptedExecutor executor;
    private final RecordingAudit audit;
    private final FixedTargets targets;
    private final UseCaseKit kit;

    ReadCommandServiceTest(ReadCommandService reads, OperationJournal journal, MaintenanceStore maintenance, ScriptedExecutor executor, RecordingAudit audit,
                           FixedTargets targets, UseCaseKit kit) {
        this.reads = reads;
        this.journal = journal;
        this.maintenance = maintenance;
        this.executor = executor;
        this.audit = audit;
        this.targets = targets;
        this.kit = kit;
    }

    @BeforeEach
    void start() {
        executor.reset();
        audit.failNothing();
        targets.reset();
    }

    private ReadCommandRequest request(RequestKey key, TargetId target, String command) {
        return new ReadCommandRequest(key, new OwnerId("owner"), target, new CommandText(command), new Utf8Text("caller"), new Utf8Text("display"), Duration.ofSeconds(15));
    }

    private ReadCommandRequest request(String command) {
        return request(kit.newKey(), FixedTargets.ID, command);
    }

    @Test
    @DisplayName("RC-A-469 a read-only command is a durable operation of the read profile, started by the read authority; the audit lines are submitted, execution-queued, policy-execution-started, completed")
    void aReadCommandIsADurableOperation() throws Exception {
        Operation done = reads.run(request("cat /tmp/a"));
        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(done.profile()).isEqualTo(FixedTargets.READ_PROFILE);
        assertThat(done.approvalMode()).isEqualTo(ApprovalMode.AUTOMATIC);
        assertThat(executor.sentLines()).containsExactly("cat /tmp/a");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(audit.actionsOf(done.id()))
            .containsExactly(AuditAction.SUBMITTED, AuditAction.EXECUTION_QUEUED, AuditAction.POLICY_EXECUTION_STARTED, AuditAction.COMPLETED));
    }

    @Test
    @DisplayName("RC-A-469 a command that fails to exit cleanly comes back as the failed operation with its result, not as an exception")
    void aFailedReadCommandIsReturned() throws Exception {
        executor.when("cat /tmp/missing", executor.exits(1, "cat: no such file\n"));
        Operation done = reads.run(request("cat /tmp/missing"));
        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        assertThat(((Settlement.Settled) done.settlement()).result()).isInstanceOf(RecordedResult.Executed.class);
    }

    @Test
    @DisplayName("RC-A-469 a command that is not read-only is READ_COMMAND_REQUIRES_APPROVAL and writes nothing; a maintenance window is MAINTENANCE_ACTIVE")
    void onlyReadOnlyCommandsRunWithoutApproval() {
        RequestKey key = kit.newKey();
        assertThatThrownBy(() -> reads.run(request(key, FixedTargets.ID, "sudo id"))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.READ_COMMAND_REQUIRES_APPROVAL));
        assertThat(journal.findByRequestKey(key)).isEmpty();

        OwnerHash owner = new OwnerHash((UUID.randomUUID().toString() + UUID.randomUUID()).replace("-", ""));
        maintenance.reserve(owner);
        try {
            assertThatThrownBy(() -> reads.run(request("cat /tmp/a"))).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE));
        } finally {
            maintenance.release(owner);
        }
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("RC-A-468 an execution-queued audit that does not become durable is READ_COMMAND_NOT_STARTED without the audit's text; the operation is cancelled and nothing ran")
    void aQueuedAuditFailureIsNotStarted() {
        audit.failOn(AuditAction.EXECUTION_QUEUED);
        RequestKey key = kit.newKey();
        assertThatThrownBy(() -> reads.run(request(key, FixedTargets.ID, "cat /tmp/a"))).isInstanceOfSatisfying(RequestRefusedException.class, e -> {
            assertThat(e.code()).isEqualTo(RequestErrorCode.READ_COMMAND_NOT_STARTED);
            assertThat(e.getMessage()).doesNotContain("SECRET-AUDIT-DETAIL");
            assertThat(e.attempt()).isEqualTo(ExecutionAttempt.NOT_ATTEMPTED);
        });
        assertThat(journal.findByRequestKey(key).orElseThrow().state()).isEqualTo(OperationState.CANCELLED);
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("RC-A-468 RC-B-358 a start audit that fails sends nothing and fails the operation; the capacity is given back and the next command completes")
    void aStartAuditFailureReturnsTheCapacity() throws Exception {
        audit.failOn(AuditAction.POLICY_EXECUTION_STARTED);
        Operation failed = reads.run(request("cat /tmp/a"));
        assertThat(failed.state()).isEqualTo(OperationState.FAILED);
        assertThat(((Settlement.Settled) failed.settlement()).result())
            .isEqualTo(new RecordedResult.Refused(DispatchFailure.stepFailed(DispatchStage.START_AUDIT, DispatchReason.AUDIT_FAILED)));
        assertThat(executor.requestsSent()).isZero();

        audit.failNothing();
        Operation next = reads.run(request("cat /tmp/b"));
        assertThat(next.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(executor.sentLines()).containsExactly("cat /tmp/b");
    }

    @Test
    @DisplayName("RC-A-468 RC-A-471 a final audit that fails returns the original outcome: completed, run once, and marked so that it is not retried")
    void aFinalAuditFailureKeepsTheOutcome() throws Exception {
        audit.failOn(AuditAction.COMPLETED);
        Operation done = reads.run(request("cat /tmp/a"));
        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(kit.find(done.id()).audit()).isEqualTo(AuditState.FAILED));
        assertThat(executor.requestsSent()).isEqualTo(1);
    }

    @Test
    @DisplayName("RC-A-467 an execution of unknown outcome is READ_COMMAND_EXECUTION_UNKNOWN without the text of the transport, in the exception and in the audit; the next read runs")
    void anUnknownOutcomeHidesTheTransportText() throws Exception {
        executor.when("cat /tmp/explodes", executor.failsUnexpectedly());
        assertThatThrownBy(() -> reads.run(request("cat /tmp/explodes"))).isInstanceOfSatisfying(RequestRefusedException.class, e -> {
            assertThat(e.code()).isEqualTo(RequestErrorCode.READ_COMMAND_EXECUTION_UNKNOWN);
            assertThat(e.getMessage()).doesNotContain("SECRET-TRANSPORT-CONTENT");
            assertThat(e.getCause()).isNull();
        });
        assertThat(executor.requestsSent()).isEqualTo(1);
        Operation next = reads.run(request("cat /tmp/after"));
        assertThat(next.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(audit.all()).noneMatch(event -> event.note().contains("SECRET-TRANSPORT-CONTENT"));
    }

    @Test
    @DisplayName("RC-B-356 a NUL in the command is refused when the command is made, and an unregistered target is TARGET_UNAVAILABLE; nothing is queued or run")
    void badInputIsRefusedWithoutDetails() {
        assertThatThrownBy(() -> new CommandText("cat /tmp/x\0")).isInstanceOf(IllegalArgumentException.class);
        RequestKey key = kit.newKey();
        assertThatThrownBy(() -> reads.run(request(key, new TargetId("not-registered"), "cat /tmp/a"))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_UNAVAILABLE));
        assertThat(journal.findByRequestKey(key)).isEmpty();
        assertThat(executor.requestsSent()).isZero();
    }
}
