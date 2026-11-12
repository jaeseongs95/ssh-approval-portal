package io.github.jaeseongs95.portal.store.journal;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.SaturationReason;

/**
 * S2-DB-06: claims from two threads. The slice does not wrap these tests in a transaction (every call commits on its own, as in the product), so the rows are removed
 * after each test.
 */
@JournalTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class JdbcClaimStoreConcurrencyTest {

    private static final ConcurrencyLimits ONE_AT_A_TIME = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(1)).withTargetConcurrency(new Capacity(5));
    private static final int ROUNDS = 8;

    private final JdbcOperationJournal journal;
    private final JdbcClaimStore claims;
    private final JdbcTemplate jdbc;
    private final JournalFixture fx = new JournalFixture();

    JdbcClaimStoreConcurrencyTest(JdbcOperationJournal journal, JdbcClaimStore claims, JdbcTemplate jdbc) {
        this.journal = journal;
        this.claims = claims;
        this.jdbc = jdbc;
    }

    @AfterEach
    void removeTheRows() {
        for (String table : List.of("operation_slot", "operation_fence", "operation_event", "operation_command", "operation")) {
            jdbc.update("DELETE FROM " + table);
        }
    }

    @Test
    @DisplayName("S2-DB-06: two threads claim two different operations at the same instant under a global limit of 1: exactly one is Claimed")
    void exactlyOneOfTwoDifferentOperationsIsClaimed() throws Exception {
        for (int round = 0; round < ROUNDS; round++) {
            Operation a = fx.queued(journal, fx.command("a" + round, "alpha", "echo a", new ConflictKey.None()));
            Operation b = fx.queued(journal, fx.command("b" + round, "beta", "echo b", new ConflictKey.None()));

            List<ClaimResult> results = raceTwoClaims(a, b);

            assertThat(results.stream().filter(ClaimResult.Claimed.class::isInstance).count()).as("round " + round).isEqualTo(1);
            assertThat(results.stream().filter(result -> !(result instanceof ClaimResult.Claimed)).toList()).as("the loser of round " + round)
                .allSatisfy(result -> assertThat(result).isIn(new ClaimResult.Contended(), new ClaimResult.Saturated(SaturationReason.GLOBAL_CONCURRENCY)));
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot WHERE scope = 'GLOBAL'", Long.class)).as("round " + round).isEqualTo(1);
            removeTheRows();
        }
    }

    @Test
    @DisplayName("S2-DB-06: two threads claim the same operation at the same instant: exactly one is Claimed, the other is told it is no longer queued or lost the race")
    void exactlyOneOfTwoClaimsOfTheSameOperationWins() throws Exception {
        for (int round = 0; round < ROUNDS; round++) {
            Operation queued = fx.queued(journal, fx.command("same" + round, "alpha", "echo", new ConflictKey.None()));

            List<ClaimResult> results = raceTwoClaims(queued, queued);

            assertThat(results.stream().filter(ClaimResult.Claimed.class::isInstance).count()).as("round " + round).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_slot WHERE scope = 'GLOBAL'", Long.class)).as("round " + round).isEqualTo(1);
            removeTheRows();
        }
    }

    @Test
    @DisplayName("S2-DB-06: two operations with the same conflict key claimed at the same instant: exactly one holds the fence")
    void exactlyOneOfTwoOperationsOfAConflictKeyIsClaimed() throws Exception {
        ConcurrencyLimits roomy = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(10)).withTargetConcurrency(new Capacity(10));
        for (int round = 0; round < ROUNDS; round++) {
            Operation a = fx.queued(journal, fx.command("fa" + round, "alpha", "echo a", new ConflictKey.Of("installer")));
            Operation b = fx.queued(journal, fx.command("fb" + round, "alpha", "echo b", new ConflictKey.Of("installer")));

            List<ClaimResult> results = raceTwoClaims(a, b, roomy);

            assertThat(results.stream().filter(ClaimResult.Claimed.class::isInstance).count()).as("round " + round).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM operation_fence", Long.class)).as("round " + round).isEqualTo(1);
            removeTheRows();
        }
    }

    private List<ClaimResult> raceTwoClaims(Operation first, Operation second) throws Exception {
        return raceTwoClaims(first, second, ONE_AT_A_TIME);
    }

    private List<ClaimResult> raceTwoClaims(Operation first, Operation second, ConcurrencyLimits limits) throws InterruptedException, ExecutionException, TimeoutException {
        // The pool is the test's own: the threads are what the dispatcher and a second instance would be.
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            CyclicBarrier together = new CyclicBarrier(2);
            List<Future<ClaimResult>> futures = new ArrayList<>();
            for (Operation operation : List.of(first, second)) {
                futures.add(pool.submit(() -> {
                    together.await(10, TimeUnit.SECONDS);
                    return claims.claim(operation.id(), operation.version(), limits, JournalFixture.NOW.plusSeconds(10));
                }));
            }
            List<ClaimResult> results = new ArrayList<>();
            for (Future<ClaimResult> future : futures) {
                results.add(future.get(30, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
