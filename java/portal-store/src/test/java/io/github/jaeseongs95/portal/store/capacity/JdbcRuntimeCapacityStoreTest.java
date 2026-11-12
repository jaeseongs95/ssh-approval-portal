package io.github.jaeseongs95.portal.store.capacity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;

import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.capacity.CapacityState;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.contract.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.CapacityOverride;
import io.github.jaeseongs95.portal.store.Savepoints;
import io.github.jaeseongs95.portal.store.StoreTest;

/**
 * RC-B-405 .. RC-B-409 (2.x {@code test/runtime-capacity.test.mjs}, {@code test/runtime-capacity-180.test.mjs}), the store part. The scheduler configuration, the
 * maintenance refusal, the validation of a patch (revision token, unknown target id) and the audit failure belong to the use case that owns them (later stage) and are
 * not written here.
 */
@StoreTest
@Import({JdbcRuntimeCapacityStore.class, CapacityMapper.class})
class JdbcRuntimeCapacityStoreTest {

    private static final String REVISION_A = "a".repeat(32);
    private static final String REVISION_B = "b".repeat(32);
    private static final String REVISION_C = "c".repeat(32);
    private static final long WAIT_SECONDS = 30;

    private final JdbcRuntimeCapacityStore store;
    private final JdbcTemplate jdbc;
    private final Savepoints savepoints;

    JdbcRuntimeCapacityStoreTest(JdbcRuntimeCapacityStore store, JdbcTemplate jdbc, Savepoints savepoints) {
        this.store = store;
        this.jdbc = jdbc;
        this.savepoints = savepoints;
    }

    /** A statement that the schema must refuse, run in its own savepoint: PostgreSQL rejects every later statement of a transaction after the first failed one (S2-DB-17). */
    private void refused(String sql, Object... arguments) {
        assertThatThrownBy(() -> savepoints.run(() -> jdbc.update(sql, arguments))).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    @DisplayName("RC-B-405: nothing is stored on a fresh installation; the first initialize stores the state and a later initialize returns the stored one, not its own")
    void theStoredStateWinsOverALaterInitialize() {
        assertThat(store.read()).isEmpty();
        CapacityState first = state(REVISION_A, 40, 4, explicit("alpha", 7, null));

        assertThat(store.initialize(first)).isEqualTo(first);
        assertThat(store.read()).contains(first);
        CapacityState other = state(REVISION_B, 20, 2, new CapacityState.TargetCapacity(new TargetId("windows"), new CapacityOverride.Inherited(),
            new CapacityOverride.Explicit(new Capacity(1))));

        assertThat(store.initialize(other)).isEqualTo(first);
        assertThat(store.read()).contains(first);
    }

    @Test
    @DisplayName("RC-B-405: a reduction to 1 and 1 with an override set back to inherited is stored with the new revision, and a stale revision changes nothing")
    void aReductionIsStoredAndAStaleRevisionChangesNothing() {
        CapacityState first = state(REVISION_A, 20, 2, explicit("alpha", 7, null), explicit("windows", null, 1));
        store.initialize(first);
        CapacityState reduced = state(REVISION_B, 1, 1, explicit("alpha", null, null), explicit("windows", null, 1));

        store.compareAndSet(REVISION_A, reduced);

        assertThat(store.read()).contains(reduced);
        CapacityState stale = state(REVISION_C, 3, 1, explicit("windows", null, null));
        assertThatThrownBy(() -> store.compareAndSet(REVISION_A, stale)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.CAPACITY_REVISION_CONFLICT));
        assertThat(store.read()).contains(reduced);
    }

    @Test
    @DisplayName("RC-B-406: of two writers that start from the same revision the second one is refused with CAPACITY_REVISION_CONFLICT and its state is not stored")
    void theSecondWriterOfTheSameRevisionIsRefused() {
        CapacityState first = state(REVISION_A, 10, 2);
        store.initialize(first);
        CapacityState winner = state(REVISION_B, 5, 2);
        CapacityState loser = state(REVISION_C, 6, 3, explicit("alpha", 9, 9));

        store.compareAndSet(REVISION_A, winner);

        assertThatThrownBy(() -> store.compareAndSet(REVISION_A, loser)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.CAPACITY_REVISION_CONFLICT));
        assertThat(store.read()).contains(winner);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM runtime_capacity_target", Integer.class)).isZero();
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    @DisplayName("RC-B-406: two threads that write from the same revision at the same time leave exactly one state, the winner's, and refuse the other")
    void concurrentWritersOfTheSameRevisionLeaveOneState() throws Exception {
        CapacityState first = state(REVISION_A, 10, 2);
        CapacityState stateB = state(REVISION_B, 5, 2, explicit("alpha", 3, null));
        CapacityState stateC = state(REVISION_C, 6, 3, explicit("beta", null, 2));
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            store.initialize(first);
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<Throwable> resultB = pool.submit(attempt(barrier, stateB));
            Future<Throwable> resultC = pool.submit(attempt(barrier, stateC));
            Throwable failureB = resultB.get(WAIT_SECONDS, TimeUnit.SECONDS);
            Throwable failureC = resultC.get(WAIT_SECONDS, TimeUnit.SECONDS);

            assertThat(List.of(failureB == null, failureC == null)).containsExactlyInAnyOrder(true, false);
            assertThat(failureB == null ? failureC : failureB).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.CAPACITY_REVISION_CONFLICT));
            assertThat(store.read()).contains(failureB == null ? stateB : stateC);
        } finally {
            clean();
        }
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    @DisplayName("RC-B-405: two threads that initialize an empty store at the same time both get the same state, the winner's")
    void concurrentFirstWritersGetOneState() throws Exception {
        CapacityState stateB = state(REVISION_B, 5, 2, explicit("alpha", 3, null));
        CapacityState stateC = state(REVISION_C, 6, 3, explicit("beta", null, 2));
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            CyclicBarrier barrier = new CyclicBarrier(2);
            Future<CapacityState> resultB = pool.submit(initialization(barrier, stateB));
            Future<CapacityState> resultC = pool.submit(initialization(barrier, stateC));
            CapacityState seenByB = resultB.get(WAIT_SECONDS, TimeUnit.SECONDS);
            CapacityState seenByC = resultC.get(WAIT_SECONDS, TimeUnit.SECONDS);

            assertThat(seenByB).isEqualTo(seenByC);
            assertThat(List.of(stateB, stateC)).contains(seenByB);
            assertThat(store.read()).contains(seenByB);
        } finally {
            clean();
        }
    }

    @Test
    @DisplayName("RC-B-407: a value that breaks a CHECK or NOT NULL of the schema cannot be stored")
    void aValueThatBreaksTheSchemaCannotBeStored() {
        String insert = "INSERT INTO runtime_capacity (id, revision, queue_capacity, max_concurrency, version) VALUES (?, ?, ?, ?, 1)";

        refused(insert, 1, REVISION_A, 0, 1);
        refused(insert, 1, REVISION_A, 1, 0);
        refused(insert, 1, REVISION_A, null, 1);
        refused(insert, 1, null, 1, 1);
        refused(insert, 2, REVISION_A, 1, 1);
        refused("INSERT INTO runtime_capacity_target (target_id, queue_capacity, max_concurrency) VALUES ('alpha', 0, NULL)");
        refused("INSERT INTO runtime_capacity_target (target_id, queue_capacity, max_concurrency) VALUES (NULL, 1, NULL)");
        assertThat(store.read()).isEmpty();
    }

    @Test
    @DisplayName("RC-B-407: a stored state whose revision is not 32 hex characters (the schema has no CHECK for the shape) is refused on read, not repaired")
    void aDamagedRevisionIsRefusedOnRead() {
        jdbc.update("INSERT INTO runtime_capacity (id, revision, queue_capacity, max_concurrency, version) VALUES (1, 'bad', 1, 1, 1)");

        assertThatThrownBy(() -> store.read()).isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForObject("SELECT revision FROM runtime_capacity WHERE id = 1", String.class)).as("CHAR(32) pads the stored text to its width").isEqualTo("bad".concat(" ".repeat(29)));
    }

    @Test
    @DisplayName("RC-B-408: the broken-JSON case of 2.x cannot exist in the table; text that is not a revision is refused on read and the stored row is not replaced")
    void textInTheRevisionColumnIsRefusedAndKept() {
        jdbc.update("INSERT INTO runtime_capacity (id, revision, queue_capacity, max_concurrency, version) VALUES (1, '{invalid', 1, 1, 1)");

        assertThatThrownBy(() -> store.read()).isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForObject("SELECT revision FROM runtime_capacity WHERE id = 1", String.class)).as("CHAR(32) pads the stored text to its width").isEqualTo("{invalid".concat(" ".repeat(24)));
    }

    @Test
    @DisplayName("RC-B-409: the override of a target that is not in the configuration is stored and read back; a state that names a target twice is refused")
    void theOverrideOfAnUnknownTargetIsKept() {
        CapacityState first = state(REVISION_A, 10, 2, explicit("windows", 7, null));
        store.initialize(first);
        CapacityState next = state(REVISION_B, 10, 2, explicit("linux", null, 3), explicit("windows", 7, null));

        store.compareAndSet(REVISION_A, next);

        assertThat(store.read()).contains(next);
        CapacityState twice = state(REVISION_C, 10, 2, explicit("linux", 1, null), explicit("linux", 2, null));
        assertThatThrownBy(() -> store.compareAndSet(REVISION_B, twice)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.INVALID_CAPACITY_TARGETS));
        assertThatThrownBy(() -> store.initialize(twice)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(CapacityErrorCode.INVALID_CAPACITY_TARGETS));
        assertThat(store.read()).contains(next);
    }

    private Callable<Throwable> attempt(CyclicBarrier barrier, CapacityState next) {
        return () -> {
            barrier.await(WAIT_SECONDS, TimeUnit.SECONDS);
            return catchThrowable(() -> store.compareAndSet(REVISION_A, next));
        };
    }

    private Callable<CapacityState> initialization(CyclicBarrier barrier, CapacityState initial) {
        return () -> {
            barrier.await(WAIT_SECONDS, TimeUnit.SECONDS);
            return store.initialize(initial);
        };
    }

    private void clean() {
        jdbc.update("DELETE FROM runtime_capacity_target");
        jdbc.update("DELETE FROM runtime_capacity");
    }

    private CapacityState state(String revision, int queue, int concurrency, CapacityState.TargetCapacity... overrides) {
        return new CapacityState(revision, new Capacity(queue), new Capacity(concurrency), List.of(overrides));
    }

    private CapacityState.TargetCapacity explicit(String target, Integer queue, Integer concurrency) {
        return new CapacityState.TargetCapacity(new TargetId(target), override(queue), override(concurrency));
    }

    private CapacityOverride override(Integer value) {
        if (value == null) {
            return new CapacityOverride.Inherited();
        }
        return new CapacityOverride.Explicit(new Capacity(value));
    }
}
