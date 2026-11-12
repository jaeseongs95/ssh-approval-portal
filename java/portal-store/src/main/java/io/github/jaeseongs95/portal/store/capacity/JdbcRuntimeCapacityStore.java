package io.github.jaeseongs95.portal.store.capacity;

import java.util.HashSet;
import java.util.Optional;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import io.github.jaeseongs95.portal.app.capacity.CapacityState;
import io.github.jaeseongs95.portal.app.capacity.RuntimeCapacityStore;
import io.github.jaeseongs95.portal.domain.contract.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.store.Savepoints;

/**
 * {@link RuntimeCapacityStore} over {@code runtime_capacity} (one row) and {@code runtime_capacity_target} (migration V6, 2.x {@code runtime-capacity-state.mjs}).
 * {@link #compareAndSet} is a conditional UPDATE on the contract revision: the winner replaces the override rows in the same transaction and a stale writer matches no
 * row. The store keeps every override it is given, also one of a target that left the configuration (no foreign key); which overrides to keep is the use case's rule.
 */
@Repository
public class JdbcRuntimeCapacityStore implements RuntimeCapacityStore {

    private static final Logger LOG = LoggerFactory.getLogger(JdbcRuntimeCapacityStore.class);
    private static final int THE_ROW = 1;
    private static final long FIRST_VERSION = 1;

    private final RuntimeCapacityRowRepository capacities;
    private final RuntimeCapacityTargetRowRepository targets;
    private final JdbcAggregateOperations aggregates;
    private final CapacityMapper mapper;
    private final TransactionTemplate transactions;
    private final Savepoints savepoints;

    public JdbcRuntimeCapacityStore(RuntimeCapacityRowRepository capacities, RuntimeCapacityTargetRowRepository targets, JdbcAggregateOperations aggregates,
                                    CapacityMapper mapper, PlatformTransactionManager transactionManager, Savepoints savepoints) {
        this.capacities = capacities;
        this.targets = targets;
        this.aggregates = aggregates;
        this.mapper = mapper;
        this.transactions = new TransactionTemplate(transactionManager);
        this.savepoints = savepoints;
    }

    /** The global row and the override rows are read in one snapshot so that a write that commits in between cannot mix two states. */
    @Override
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Optional<CapacityState> read() {
        return load();
    }

    /**
     * Stores {@code initial} when no state exists and returns the stored state. Two first writers collide on the primary key; the loser reads the winner's state.
     * The insert runs in its own transaction, or in a savepoint when the caller has one, so that the failed insert is rolled back before the winner's state is read
     * (PostgreSQL aborts a transaction after an error; S2-DB-17).
     */
    @Override
    public CapacityState initialize(CapacityState initial) {
        requireDistinctTargets(initial);
        Optional<CapacityState> existing = transactions.execute(status -> load());
        if (existing != null && existing.isPresent()) {
            return existing.orElseThrow();
        }
        try {
            savepoints.run(() -> insertFirst(initial));
            return initial;
        } catch (DuplicateKeyException e) {
            LOG.info("Another writer initialized the runtime capacity first; the stored state is used", e);
            Optional<CapacityState> winner = transactions.execute(status -> load());
            return winner == null ? initial : winner.orElseThrow(() -> new IllegalStateException("The runtime capacity row vanished after a duplicate insert", e));
        }
    }

    @Override
    @Transactional
    public void compareAndSet(String expectedRevision, CapacityState next) {
        requireDistinctTargets(next);
        if (capacities.replaceIfRevision(expectedRevision, next.revision(), next.queueCapacity().value(), next.maxConcurrency().value()) != 1) {
            throw new RequestRefusedException(CapacityErrorCode.CAPACITY_REVISION_CONFLICT);
        }
        targets.deleteAllTargets();
        for (RuntimeCapacityTargetRow row : mapper.targetRows(next)) {
            aggregates.insert(row);
        }
    }

    private Optional<CapacityState> load() {
        return capacities.findById(THE_ROW).map(row -> mapper.state(row, targets.findAllOrdered()));
    }

    private void insertFirst(CapacityState initial) {
        aggregates.insert(mapper.row(initial, FIRST_VERSION));
        for (RuntimeCapacityTargetRow row : mapper.targetRows(initial)) {
            aggregates.insert(row);
        }
    }

    /** A state with one target twice cannot be stored (primary key); it is refused before any write so that a key violation always means a competing writer. */
    private void requireDistinctTargets(CapacityState state) {
        Set<String> seen = new HashSet<>();
        for (CapacityState.TargetCapacity target : state.targets()) {
            if (!seen.add(target.targetId().value())) {
                throw new RequestRefusedException(CapacityErrorCode.INVALID_CAPACITY_TARGETS);
            }
        }
    }
}
