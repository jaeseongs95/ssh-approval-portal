package io.github.jaeseongs95.portal.server.usecase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.operation.Observation;
import io.github.jaeseongs95.portal.app.operation.OperationIntake;
import io.github.jaeseongs95.portal.app.operation.OperationsService;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;

/**
 * How operations enter, are approved, denied, expire and are observed, with the real journal over the embedded H2 database (stage 3 design 8.2 groups G2, G5, G6;
 * cases B-233 to B-235, B-238, B-234, B-242, B-193, A-142, A-144 to A-146, A-470). Only the SSH executor, the audit port and the target platform are plain test classes.
 */
@UseCaseTest
class OperationIntakeTest {

    private static final StartAuthority OWNER = new StartAuthority.Owner();

    private final OperationIntake intake;
    private final OperationsService operations;
    private final OperationJournal journal;
    private final MaintenanceStore maintenance;
    private final ScriptedExecutor executor;
    private final RecordingAudit audit;
    private final FixedTargets targets;
    private final UseCaseKit kit;
    private final RecordingTerminalListener listener;

    OperationIntakeTest(OperationIntake intake, OperationsService operations, OperationJournal journal, MaintenanceStore maintenance, ScriptedExecutor executor,
                        RecordingAudit audit, FixedTargets targets, UseCaseKit kit, RecordingTerminalListener listener) {
        this.intake = intake;
        this.operations = operations;
        this.journal = journal;
        this.maintenance = maintenance;
        this.executor = executor;
        this.audit = audit;
        this.targets = targets;
        this.kit = kit;
        this.listener = listener;
    }

    @BeforeEach
    void start() {
        executor.reset();
        audit.failNothing();
        targets.reset();
    }

    private static RequestRefusedException refusalOf(CompletionStage<?> stage) {
        CompletableFuture<?> future = stage.toCompletableFuture();
        future.handle((value, error) -> null).join();
        assertThat(future).isCompletedExceptionally();
        Throwable error = future.exceptionNow();
        assertThat(error).isInstanceOf(RequestRefusedException.class);
        return (RequestRefusedException) error;
    }

    private static OwnerHash newOwner() {
        return new OwnerHash((UUID.randomUUID().toString() + UUID.randomUUID()).replace("-", ""));
    }

    @Test
    @DisplayName("RC-B-233 the same key and contract is one operation: a second and a parallel submit return the same identity, and the journal holds one row for the key")
    void theSameKeyIsOneOperation() throws Exception {
        NewOperation spec = kit.command("echo same-key");
        Operation first = intake.submit(spec);
        CompletableFuture<Operation> parallel = CompletableFuture.supplyAsync(() -> intake.submit(spec));
        CompletableFuture<Operation> another = CompletableFuture.supplyAsync(() -> intake.submit(spec));
        assertThat(parallel.get(20, TimeUnit.SECONDS).id()).isEqualTo(first.id());
        assertThat(another.get(20, TimeUnit.SECONDS).id()).isEqualTo(first.id());
        assertThat(intake.submit(spec).id()).isEqualTo(first.id());
        assertThat(journal.findByRequestKey(spec.requestKey()).orElseThrow().id()).isEqualTo(first.id());
        assertThat(audit.actionsOf(first.id())).containsExactly(AuditAction.SUBMITTED);
        intake.deny(first.id());
    }

    @Test
    @DisplayName("RC-B-235 the same key with a changed command is OPERATION_KEY_CONFLICT, and an independent key is accepted; the first operation is untouched")
    void aChangedContractForAKnownKeyIsRefused() {
        RequestKey key = kit.newKey();
        Operation first = intake.submit(kit.command(key, "echo original"));
        assertThatThrownBy(() -> intake.submit(kit.command(key, "echo changed"))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.OPERATION_KEY_CONFLICT));
        Operation independent = intake.submit(kit.command("echo independent"));
        assertThat(independent.id()).isNotEqualTo(first.id());
        assertThat(kit.find(first.id()).state()).isEqualTo(OperationState.PENDING);
        intake.deny(first.id());
        intake.deny(independent.id());
    }

    @Test
    @DisplayName("RC-B-234 an operation for a target revision that is not the current one is TARGET_REVISION_CONFLICT, a switched-off target is TARGET_UNAVAILABLE, and nothing is written")
    void theTargetIsCheckedAtTheDoor() {
        NewOperation stale = kit.command("echo stale");
        targets.change("Web changed");
        assertThatThrownBy(() -> intake.submit(stale)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_REVISION_CONFLICT));
        assertThat(journal.findByRequestKey(stale.requestKey())).isEmpty();
        targets.reset();
        targets.disable();
        NewOperation disabled = kit.command("echo disabled");
        assertThatThrownBy(() -> intake.submit(disabled)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_UNAVAILABLE));
        assertThat(journal.findByRequestKey(disabled.requestKey())).isEmpty();
    }

    @Test
    @DisplayName("RC-B-238 RC-A-469 a request in a maintenance window is MAINTENANCE_ACTIVE and writes nothing, so the same key is accepted after the window")
    void aRefusedRequestFreesItsKey() {
        OwnerHash owner = newOwner();
        NewOperation spec = kit.command("echo window");
        maintenance.reserve(owner);
        try {
            assertThatThrownBy(() -> intake.submit(spec)).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE));
            assertThat(journal.findByRequestKey(spec.requestKey())).isEmpty();
        } finally {
            maintenance.release(owner);
        }
        Operation accepted = intake.submit(spec);
        assertThat(accepted.state()).isEqualTo(OperationState.PENDING);
        assertThat(executor.requestsSent()).isZero();
        intake.deny(accepted.id());
    }

    @Test
    @DisplayName("RC-A-145 an audit that does not become durable stops the approval with StepFailed(START_AUDIT, AUDIT_FAILED): the operation stays pending, nothing runs, and the approval works when the audit does")
    void anApprovalNeedsItsAudit() throws Exception {
        Operation pending = intake.submit(kit.command("echo audited-approval"));
        audit.failOn(AuditAction.EXECUTION_QUEUED);
        assertThatThrownBy(() -> intake.approve(pending.id(), OWNER)).isInstanceOfSatisfying(DispatchRefusedException.class, e -> {
            assertThat(e.failure()).isEqualTo(DispatchFailure.stepFailed(DispatchStage.START_AUDIT, DispatchReason.AUDIT_FAILED));
            assertThat(e.getMessage()).doesNotContain("SECRET-AUDIT-DETAIL");
        });
        assertThat(kit.find(pending.id()).state()).isEqualTo(OperationState.PENDING);
        assertThat(executor.requestsSent()).isZero();

        audit.failNothing();
        intake.approve(pending.id(), OWNER);
        assertThat(kit.awaitTerminal(pending.id()).state()).isEqualTo(OperationState.COMPLETED);
        assertThat(executor.requestsSent()).isEqualTo(1);
    }

    @Test
    @DisplayName("RC-A-144 a denied operation never runs, is audited and announced once, and cannot be approved afterwards")
    void aDeniedOperationNeverRuns() {
        Operation pending = intake.submit(kit.command("echo denied"));
        Operation denied = intake.deny(pending.id());
        assertThat(denied.state()).isEqualTo(OperationState.DENIED);
        assertThatThrownBy(() -> intake.approve(pending.id(), OWNER)).isInstanceOfSatisfying(DispatchRefusedException.class,
            e -> assertThat(e.failure()).isEqualTo(DispatchFailure.refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE)));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(audit.actionsOf(pending.id())).containsExactly(AuditAction.SUBMITTED, AuditAction.DENIED);
            assertThat(listener.timesTold(pending.id())).isEqualTo(1);
        });
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("RC-A-146 RC-A-470 an operation whose deadline passes while it waits for the owner expires by its own timer, wakes the observer, is audited, and can no longer be approved")
    void aPendingOperationExpiresByItsTimer() throws Exception {
        Operation pending = intake.submit(kit.command("echo late", new Deadline.At(Instant.now().plusMillis(400))));
        Observation seen = operations.observe(pending.id(), Duration.ofSeconds(10), new CancelSource()).toCompletableFuture().get(15, TimeUnit.SECONDS);
        assertThat(seen.operation().state()).isEqualTo(OperationState.EXPIRED);
        assertThat(seen.waitTimedOut()).isFalse();
        assertThatThrownBy(() -> intake.approve(pending.id(), OWNER)).isInstanceOf(DispatchRefusedException.class);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(audit.actionsOf(pending.id())).contains(AuditAction.EXPIRED);
            assertThat(listener.timesTold(pending.id())).isEqualTo(1);
        });
        assertThat(executor.requestsSent()).isZero();
    }

    @Test
    @DisplayName("RC-A-142 an observer that waits for a change is woken by the approval and sees the new state, not a timeout")
    void anObserverIsWokenByTheApproval() throws Exception {
        Operation pending = intake.submit(kit.command("echo wake-me"));
        CompletableFuture<Observation> watching = operations.observe(pending.id(), Duration.ofSeconds(20), new CancelSource()).toCompletableFuture();
        assertThat(watching).isNotDone();
        intake.approve(pending.id(), OWNER);
        Observation seen = watching.get(15, TimeUnit.SECONDS);
        assertThat(seen.operation().version()).isGreaterThan(pending.version());
        assertThat(seen.waitTimedOut()).isFalse();
        kit.awaitTerminal(pending.id());
    }

    @Test
    @DisplayName("RC-B-242 RC-B-193 an observe without a wait returns the running operation at once; an observer that aborts ends only its wait with OPERATION_OBSERVER_ABORTED and the operation runs on")
    void observeReturnsRunningAndAnAbortCancelsNothing() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        executor.when("held", executor.blocksUntil(release));
        Operation running = intake.submit(kit.command("held"));
        intake.approve(running.id(), OWNER);
        kit.await(running.id(), operation -> operation.state() == OperationState.RUNNING);

        CompletableFuture<Observation> immediate = operations.observe(running.id(), Duration.ZERO, new CancelSource()).toCompletableFuture();
        assertThat(immediate).isDone();
        assertThat(immediate.get().operation().state()).isEqualTo(OperationState.RUNNING);
        assertThat(immediate.get().waitTimedOut()).isFalse();

        CancelSource abort = new CancelSource();
        CompletionStage<Observation> waiting = operations.observe(running.id(), Duration.ofSeconds(30), abort);
        abort.cancel();
        assertThat(refusalOf(waiting).code()).isEqualTo(OperationErrorCode.OPERATION_OBSERVER_ABORTED);
        assertThat(kit.find(running.id()).state()).isEqualTo(OperationState.RUNNING);
        assertThat(executor.requestsSent()).isEqualTo(1);

        release.countDown();
        assertThat(kit.awaitTerminal(running.id()).state()).isEqualTo(OperationState.COMPLETED);
    }

    @Test
    @DisplayName("RC-B-234 an observer that waited, and a cancel, are TARGET_REVISION_CONFLICT when the target changed since the operation was approved")
    void aChangedTargetIsAConflictAfterTheWaitAndForACancel() throws Exception {
        Operation pending = intake.submit(kit.command("echo moved-target"));
        CompletionStage<Observation> waiting = operations.observe(pending.id(), Duration.ofMillis(300), new CancelSource());
        targets.change("Web changed while observed");
        assertThat(refusalOf(waiting).code()).isEqualTo(RequestErrorCode.TARGET_REVISION_CONFLICT);
        assertThatThrownBy(() -> operations.cancel(pending.id())).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_REVISION_CONFLICT));
        targets.reset();
        assertThat(operations.cancel(pending.id()).state()).isEqualTo(OperationState.CANCELLED);
        assertThat(executor.requestsSent()).isZero();
    }
}
