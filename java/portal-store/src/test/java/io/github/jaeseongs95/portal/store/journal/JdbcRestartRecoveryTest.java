package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
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

    /** Every table a recovery could write: the journal, its result, the slots and fences it releases, and the policy row that must stay out of it. */
    private static final List<String> TABLES = List.of("operation", "operation_command", "operation_result", "operation_event", "operation_slot", "operation_fence", "command_policy");

    private Map<String, List<Map<String, Object>>> storedRows() {
        Map<String, List<Map<String, Object>>> rows = new LinkedHashMap<>();
        for (String table : TABLES) {
            rows.put(table, jdbc.queryForList("SELECT * FROM " + table + " ORDER BY 1, 2"));
        }
        return rows;
    }

    private Operation running(String key, String target) {
        Operation started = starting(key, target);
        return journal.save(started.markRunning(JournalFixture.NOW.plusSeconds(6)), started.version());
    }

    private Operation settled(String key, String target, ExecutionOutcome outcome) {
        Operation active = running(key, target);
        return journal.save(active.settle(outcome, JournalFixture.NOW.plusSeconds(7)), active.version());
    }

    private Operation ended(Operation operation, Operation next) {
        return journal.save(next, operation.version());
    }

    /**
     * RC-A-485 in 3.0: the 2.x case stored seven states, one of them {@code accepted}, and expected no UPDATE at all. In 3.0 {@code accepted} is not terminal (design 2.1)
     * and is closed as unknown, which RC-A-486 below covers; the six states that are terminal, and a queued operation (T19 withdrawn: it stays queued), are what a restart
     * must leave untouched. The 2.x trigger that refused every UPDATE is replaced by a comparison of every stored row before and after, which runs the same on every DBMS.
     */
    @Test
    @DisplayName("RC-A-485: a restart writes nothing for operations that are final, unknown or queued: every row of the journal, its result, slots, fences and the policy keeps its value")
    void aRestartLeavesUnchangedOperationsAlone() {
        Operation completed = settled("completed", "alpha", ExecutionOutcome.exited(0, List.of("kept")));
        Operation failed = settled("failed", "beta", ExecutionOutcome.exited(2, List.of("kept")));
        Operation unknown = settled("unknown", "gamma", ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of("Operation failed; do not replay automatically.")));
        Operation deniedWaiting = fx.pending(journal, fx.command("denied", "delta", "echo", new ConflictKey.None()));
        Operation denied = ended(deniedWaiting, deniedWaiting.deny(JournalFixture.NOW.plusSeconds(8)));
        Operation cancelledWaiting = fx.pending(journal, fx.command("cancelled", "epsilon", "echo", new ConflictKey.None()));
        Operation cancelled = ended(cancelledWaiting, cancelledWaiting.requestCancel(JournalFixture.NOW.plusSeconds(8)));
        Instant deadline = JournalFixture.NOW.plusSeconds(600);
        Operation expiredWaiting = fx.pending(journal, fx.command("expired", "zeta", "echo", "owner", JournalFixture.REVISION, new ConflictKey.None(), new Deadline.At(deadline)));
        Operation expired = ended(expiredWaiting, expiredWaiting.expire(deadline));
        Operation queued = fx.queued(journal, fx.command("queued", "eta", "echo", new ConflictKey.None()));
        jdbc.update("UPDATE command_policy SET revision = 5 WHERE id = 1");
        Map<OperationState, Operation> kept = new LinkedHashMap<>();
        for (Operation operation : List.of(completed, failed, unknown, denied, cancelled, expired, queued)) {
            kept.put(operation.state(), operation);
        }
        assertThat(kept.keySet()).as("seven different states were stored").containsExactly(OperationState.COMPLETED, OperationState.FAILED, OperationState.UNKNOWN,
            OperationState.DENIED, OperationState.CANCELLED, OperationState.EXPIRED, OperationState.QUEUED);
        Map<String, List<Map<String, Object>>> before = storedRows();

        List<Operation> changed = recovery.recoverAfterRestart(RESTART);

        assertThat(changed).as("nothing was in flight").isEmpty();
        assertThat(storedRows()).usingRecursiveComparison().isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation", Long.class)).isEqualTo(7);
        for (Operation operation : kept.values()) {
            assertThat(journal.find(operation.id()).orElseThrow().snapshot()).as(operation.state().name()).isEqualTo(operation.snapshot());
        }
    }

    /**
     * RC-A-486 in 3.0: the 2.x case turned queued into unknown. T19 is withdrawn (main's ruling, design 2.3): a queued operation was never tried and stays queued, so
     * three of the four operations that 2.x changed are changed here and the queued one is not. {@code accepted}, which 2.x did not have in the journal, is added and
     * becomes unknown. 2.x kept a result on the rows it changed; in 3.0 an operation has no result before it is settled, so the retained result is the one of the
     * completed operation.
     */
    @Test
    @DisplayName("RC-A-486: a restart closes only what was in flight (unknown, unknown, unknown, expired; queued and completed stay), keeps identity, input and results, and a second recovery changes no row")
    void aRestartChangesOnlyWhatWasInFlightAndTheSecondRecoveryNothing() {
        Operation queued = fx.queued(journal, fx.command("queued", "alpha", "echo", new ConflictKey.None()));
        Operation running = running("running", "beta");
        Operation evaluating = journal.accept(fx.command("evaluating", "alpha", "echo", new ConflictKey.None())).operation();
        evaluating = journal.save(evaluating.beginEvaluation(JournalFixture.NOW), evaluating.version());
        Operation accepted = journal.accept(fx.command("accepted", "alpha", "echo", new ConflictKey.None())).operation();
        Operation pending = fx.pending(journal, fx.command("pending", "alpha", "echo", new ConflictKey.None()));
        Operation completed = settled("completed", "gamma", ExecutionOutcome.exited(0, List.of("retained result")));
        List<Map<String, Object>> identity = jdbc.queryForList("SELECT id, request_key, owner_id, target_id, target_revision, input_digest, contract_digest FROM operation ORDER BY id");
        List<Map<String, Object>> inputs = jdbc.queryForList("SELECT * FROM operation_command ORDER BY 1");
        long events = jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class);

        List<Operation> first = recovery.recoverAfterRestart(RESTART);

        assertThat(first.stream().map(Operation::id)).containsExactlyInAnyOrder(accepted.id(), evaluating.id(), pending.id(), running.id());
        Map<String, OperationState> expected = Map.of("queued", OperationState.QUEUED, "running", OperationState.UNKNOWN, "evaluating", OperationState.UNKNOWN,
            "accepted", OperationState.UNKNOWN, "pending", OperationState.EXPIRED, "completed", OperationState.COMPLETED);
        for (Map.Entry<String, OperationState> entry : expected.entrySet()) {
            assertThat(journal.findByRequestKey(fx.requestKey(entry.getKey())).orElseThrow().state()).as(entry.getKey()).isEqualTo(entry.getValue());
        }
        for (Operation operation : first) {
            assertThat(journal.find(operation.id()).orElseThrow().settlement()).isInstanceOfSatisfying(Settlement.Settled.class,
                settled -> assertThat(settled.finishedAt()).as("finished at the restart").isEqualTo(RESTART));
        }
        assertThat(jdbc.queryForList("SELECT id, request_key, owner_id, target_id, target_revision, input_digest, contract_digest FROM operation ORDER BY id"))
            .as("id, key and digests are not touched").usingRecursiveComparison().isEqualTo(identity);
        assertThat(jdbc.queryForList("SELECT * FROM operation_command ORDER BY 1")).as("the stored inputs are not touched").usingRecursiveComparison().isEqualTo(inputs);
        assertThat(journal.find(completed.id()).orElseThrow().snapshot()).as("the completed operation keeps its result").isEqualTo(completed.snapshot());
        assertThat(journal.find(queued.id()).orElseThrow().snapshot()).isEqualTo(queued.snapshot());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_event", Long.class)).as("one event for each of the four that changed").isEqualTo(events + 4);
        Map<String, List<Map<String, Object>>> afterFirst = storedRows();

        assertThat(recovery.recoverAfterRestart(RESTART.plusSeconds(60))).as("the second recovery finds nothing in flight").isEmpty();
        assertThat(storedRows()).as("and writes no row").usingRecursiveComparison().isEqualTo(afterFirst);
    }

    /**
     * RC-A-047 (the normalisation half) in 3.0: the 2.x agent CLI journal had its own state normalisation; here an agent CLI installation is an operation of the one
     * journal ({@code AGENT_CLI}, decision D-11), so the one recovery closes it. 2.x turned both {@code pending} and {@code running} into {@code unknown}; in 3.0
     * what waits for the owner expires (T21, nothing was sent) and only what ran is unknown. The remote status and the key conflict halves are in
     * {@code JdbcAgentCliRequestStoreTest}.
     */
    @Test
    @DisplayName("RC-A-047: an agent CLI operation is recovered with the others: the one that waits for the owner expires, the one that ran becomes unknown, its kind and intent are kept, a second recovery changes nothing")
    void anAgentCliOperationIsRecoveredLikeAnyOther() {
        Operation waiting = fx.pending(journal, fx.agentCli("cli-pending", "alpha", new ConflictKey.None()));
        Operation queued = fx.queued(journal, fx.agentCli("cli-running", "beta", new ConflictKey.Of("cli-running")));
        ClaimResult claimed = claims.claim(queued.id(), queued.version(), ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(10)), JournalFixture.NOW.plusSeconds(5));
        Operation started = ((ClaimResult.Claimed) claimed).operation();
        Operation running = journal.save(started.markRunning(JournalFixture.NOW.plusSeconds(6)), started.version());

        List<Operation> changed = recovery.recoverAfterRestart(RESTART);

        assertThat(changed.stream().map(Operation::id)).containsExactlyInAnyOrder(waiting.id(), running.id());
        assertThat(journal.find(waiting.id()).orElseThrow().state()).isEqualTo(OperationState.EXPIRED);
        Operation recovered = journal.find(running.id()).orElseThrow();
        assertThat(recovered.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(recovered.recovery()).isEqualTo(RecoveryReason.BRIDGE_RESTART);
        for (Operation operation : List.of(journal.find(waiting.id()).orElseThrow(), recovered)) {
            assertThat(operation.kind()).isEqualTo(OperationKind.AGENT_CLI);
            assertThat(operation.input()).isEqualTo(waiting.input());
        }
        Map<String, List<Map<String, Object>>> afterFirst = storedRows();

        assertThat(recovery.recoverAfterRestart(RESTART.plusSeconds(60))).isEmpty();
        assertThat(storedRows()).usingRecursiveComparison().isEqualTo(afterFirst);
    }
}
