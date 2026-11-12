package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecoveryReason;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

@JournalTest
class JdbcRestartRecoveryTest {

    private static final Instant RESTART = JournalFixture.NOW.plusSeconds(600);

    private final JdbcOperationJournal journal;
    private final JdbcClaimStore claims;
    private final JdbcRestartRecovery recovery;
    private final JdbcTemplate jdbc;
    private final JournalFixture fx = new JournalFixture();

    JdbcRestartRecoveryTest(JdbcOperationJournal journal, JdbcClaimStore claims, JdbcRestartRecovery recovery, JdbcTemplate jdbc) {
        this.journal = journal;
        this.claims = claims;
        this.recovery = recovery;
        this.jdbc = jdbc;
    }

    private Operation starting(String key, String target) {
        Operation queued = fx.queued(journal, fx.command(key, target, "echo " + key, new ConflictKey.Of(key)));
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(10)), JournalFixture.NOW.plusSeconds(5));
        return ((ClaimResult.Claimed) claimed).operation();
    }

    @Test
    @DisplayName("S2-ST-04, RC-A-427, RC-A-428, RC-B-203: a restart closes every operation that was in flight: waiting for the owner expires, everything else becomes unknown, nothing is replayed")
    void aRestartClosesWhatWasInFlight() {
        Operation evaluating = journal.accept(fx.command("evaluating", "alpha", "echo", new ConflictKey.None())).operation();
        evaluating = journal.save(evaluating.beginEvaluation(JournalFixture.NOW), evaluating.version());
        Operation pending = fx.pending(journal, fx.command("pending", "alpha", "echo", new ConflictKey.None()));
        Operation queued = fx.queued(journal, fx.command("queued", "alpha", "echo", new ConflictKey.None()));
        Operation starting = starting("starting", "beta");
        Operation running = starting("running", "gamma");
        running = journal.save(running.markRunning(JournalFixture.NOW.plusSeconds(6)), running.version());
        Operation done = starting("done", "delta");
        done = journal.save(done.markRunning(JournalFixture.NOW.plusSeconds(6)), done.version());
        done = journal.save(done.settle(ExecutionOutcome.exited(0, List.of("kept")), JournalFixture.NOW.plusSeconds(7)), done.version());

        List<Operation> changed = recovery.recoverAfterRestart(RESTART);

        assertThat(changed.stream().map(Operation::id)).containsExactlyInAnyOrder(evaluating.id(), pending.id(), starting.id(), running.id());
        assertThat(journal.find(queued.id()).orElseThrow().snapshot()).as("a queued operation was never tried: it stays as it is (RC-B-203, RC-B-200)").isEqualTo(queued.snapshot());
        Map<String, OperationState> expected = Map.of("evaluating", OperationState.UNKNOWN, "pending", OperationState.EXPIRED, "queued", OperationState.QUEUED,
            "starting", OperationState.UNKNOWN, "running", OperationState.UNKNOWN, "done", OperationState.COMPLETED);
        for (Map.Entry<String, OperationState> entry : expected.entrySet()) {
            Operation read = journal.findByRequestKey(fx.requestKey(entry.getKey())).orElseThrow();
            assertThat(read.state()).as(entry.getKey()).isEqualTo(entry.getValue());
        }
        for (Operation operation : changed) {
            Operation read = journal.find(operation.id()).orElseThrow();
            assertThat(read.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
            assertThat(read.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
                if (read.state() == OperationState.UNKNOWN) {
                    assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.UNKNOWN);
                    assertThat(settled.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
                } else {
                    assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED);
                }
                assertThat(settled.finishedAt()).isEqualTo(RESTART);
            });
            List<OperationEvent> history = journal.events(operation.id());
            assertThat(history.get(history.size() - 1)).as("the last event is the recovery").isEqualTo(new OperationEvent(read.version(), read.state(), RESTART));
        }
        assertThat(journal.find(done.id()).orElseThrow().snapshot()).as("an operation that had ended is not touched").isEqualTo(done.snapshot());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot", Long.class)).as("the slots of the active operations are released").isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_fence", Long.class)).as("an unknown operation keeps its fence; only the finished one released it").isEqualTo(2);
    }

    @Test
    @DisplayName("S2-ST-04, RC-B-203: a second recovery changes nothing and writes no event")
    void aSecondRecoveryChangesNothing() {
        Operation waiting = fx.pending(journal, fx.command("waiting", "alpha", "echo", new ConflictKey.None()));
        fx.queued(journal, fx.command("queued", "alpha", "echo", new ConflictKey.None()));
        assertThat(recovery.recoverAfterRestart(RESTART)).hasSize(1);
        long events = jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class);

        assertThat(recovery.recoverAfterRestart(RESTART.plusSeconds(60))).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class)).isEqualTo(events);
        assertThat(journal.find(waiting.id()).orElseThrow().state()).isEqualTo(OperationState.EXPIRED);
    }

    @Test
    @DisplayName("RC-A-428: a request key submitted again after the restart gives the same operation in the state unknown, and it is not queued again")
    void theSameKeyAfterTheRestartIsTheUnknownOperation() {
        Operation startingOperation = starting("again", "alpha");
        recovery.recoverAfterRestart(RESTART);

        Operation answer = journal.accept(fx.command("again", "alpha", "echo again", new ConflictKey.Of("again"))).operation();

        assertThat(answer.id()).isEqualTo(startingOperation.id());
        assertThat(answer.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(answer.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
    }
}
