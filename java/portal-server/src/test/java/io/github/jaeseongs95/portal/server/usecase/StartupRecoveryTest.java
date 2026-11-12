package io.github.jaeseongs95.portal.server.usecase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Clock;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.ClaimStore;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.recovery.StartupRecovery;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecoveryReason;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

/**
 * What the start does about the operations that were in flight (stage 3 design 8.2 group G8, S3-UC-05; cases B-493 to B-495): what ran or was being evaluated is
 * unknown and never sent again, what waited for the owner expires, what only queued is dispatched as usual, what ended is not touched, nobody is audited or announced
 * twice. The rows are written to the real journal the way the last run left them.
 */
@UseCaseTest
class StartupRecoveryTest {

    private final StartupRecovery recovery;
    private final OperationJournal journal;
    private final ClaimStore claims;
    private final ConcurrencyLimits limits;
    private final Clock clock;
    private final ScriptedExecutor executor;
    private final RecordingAudit audit;
    private final RecordingTerminalListener listener;
    private final FixedTargets targets;
    private final UseCaseKit kit;

    StartupRecoveryTest(StartupRecovery recovery, OperationJournal journal, ClaimStore claims, ConcurrencyLimits limits, Clock clock, ScriptedExecutor executor,
                        RecordingAudit audit, RecordingTerminalListener listener, FixedTargets targets, UseCaseKit kit) {
        this.recovery = recovery;
        this.journal = journal;
        this.claims = claims;
        this.limits = limits;
        this.clock = clock;
        this.executor = executor;
        this.audit = audit;
        this.listener = listener;
        this.targets = targets;
        this.kit = kit;
    }

    @BeforeEach
    void start() {
        executor.reset();
        audit.failNothing();
        targets.reset();
    }

    private Operation pending(String command) {
        NewOperation spec = kit.command(command);
        Operation accepted = journal.accept(spec).operation();
        return journal.save(accepted.awaitOwnerDecision(clock.instant()), accepted.version());
    }

    private Operation queued(String command) {
        Operation pending = pending(command);
        return journal.save(pending.enqueue(new StartAuthority.Owner(), clock.instant()), pending.version());
    }

    private Operation running(String command) {
        Operation queued = queued(command);
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), limits, clock.instant());
        Operation starting = ((ClaimResult.Claimed) claimed).operation();
        return journal.save(starting.markRunning(clock.instant()), starting.version());
    }

    private Operation completed(String command) {
        Operation running = running(command);
        return journal.save(running.settle(ExecutionOutcome.exited(0, List.of()), clock.instant()), running.version());
    }

    @Test
    @DisplayName("S3-UC-05 RC-B-493 an operation that was running is unknown and never sent again, a pending one expires, a finished one is not touched, and a queued one is dispatched once; each ended one is announced once and nobody is audited")
    void inFlightOperationsAreClosedAndNothingIsReplayed() throws Exception {
        Operation wasRunning = running("echo was-running");
        Operation wasPending = pending("echo was-pending");
        Operation wasQueued = queued("echo was-queued");
        Operation wasCompleted = completed("echo was-completed");

        List<Operation> changed = recovery.recover();

        assertThat(changed.stream().map(Operation::id).toList()).containsExactlyInAnyOrder(wasRunning.id(), wasPending.id());
        Operation unknown = kit.find(wasRunning.id());
        assertThat(unknown.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(unknown.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
        assertThat(((Settlement.Settled) unknown.settlement()).reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        Operation expired = kit.find(wasPending.id());
        assertThat(expired.state()).isEqualTo(OperationState.EXPIRED);
        assertThat(expired.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
        Operation untouched = kit.find(wasCompleted.id());
        assertThat(untouched.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(untouched.version()).isEqualTo(wasCompleted.version());

        assertThat(kit.awaitTerminal(wasQueued.id()).state()).isEqualTo(OperationState.COMPLETED);
        assertThat(executor.sentLines()).containsExactly("echo was-queued");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(listener.timesTold(wasRunning.id())).isEqualTo(1);
            assertThat(listener.timesTold(wasPending.id())).isEqualTo(1);
        });
        assertThat(listener.timesTold(wasCompleted.id())).isZero();
        assertThat(audit.actionsOf(wasRunning.id())).isEmpty();
        assertThat(audit.actionsOf(wasPending.id())).isEmpty();
        assertThat(audit.actionsOf(wasCompleted.id())).isEmpty();
    }

    @Test
    @DisplayName("S3-UC-05 a second recovery over the same journal changes nothing")
    void aSecondRecoveryChangesNothing() {
        Operation wasRunning = running("echo twice");
        assertThat(recovery.recover().stream().map(Operation::id).toList()).contains(wasRunning.id());
        long version = kit.find(wasRunning.id()).version();

        assertThat(recovery.recover()).isEmpty();

        assertThat(kit.find(wasRunning.id()).version()).isEqualTo(version);
        assertThat(executor.requestsSent()).isZero();
    }
}
