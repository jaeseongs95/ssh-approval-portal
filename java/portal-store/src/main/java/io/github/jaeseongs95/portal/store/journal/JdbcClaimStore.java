package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.ClaimStore;
import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.SaturationReason;

/**
 * {@link ClaimStore} with the limits kept by primary keys (design 13.2), not by a transaction isolation level (the behaviour of SERIALIZABLE differs between database
 * systems, and whether it stops "count, then update" on H2 was never confirmed).
 *
 * <p>A claim reads the operation (it must still be {@code QUEUED} at the expected version), looks for the smallest free {@code slot_no} of the scope {@code GLOBAL} and
 * of the scope {@code TARGET:<id>} inside the limit, checks the unknown budget, and then, in one nested transaction, inserts the two slot rows, inserts the fence row of
 * the conflict key and moves the operation to {@code STARTING}. Two claims that want the same slot number or the same conflict key meet at the primary key; the loser's
 * nested transaction is rolled back to its savepoint (so that on PostgreSQL the surrounding transaction is not aborted) and the answer is {@link ClaimResult.Contended}.
 * The caller decides again in its next round; nothing is replayed.
 *
 * <p>The unknown budget is only a loose bound: the count of unknown operations is read here, but settling an operation as {@code UNKNOWN} is a fact that cannot be refused,
 * so two racing claims may read the same count and the budget may be exceeded by one (design 13.2, test S2-DB-05).
 */
@Repository
public class JdbcClaimStore implements ClaimStore {

    private static final String GLOBAL_SCOPE = "GLOBAL";
    private static final String TARGET_SCOPE_PREFIX = "TARGET:";

    private final OperationRowRepository operations;
    private final OperationSlotRowRepository slots;
    private final OperationStorage storage;
    private final JdbcAggregateOperations aggregates;
    private final Digester digester;
    private final TransactionTemplate nested;

    public JdbcClaimStore(OperationRowRepository operations, OperationSlotRowRepository slots, OperationStorage storage, JdbcAggregateOperations aggregates,
                          Digester digester, PlatformTransactionManager transactions) {
        this.operations = operations;
        this.slots = slots;
        this.storage = storage;
        this.aggregates = aggregates;
        this.digester = digester;
        this.nested = new TransactionTemplate(transactions);
        this.nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
    }

    @Override
    @Transactional
    public ClaimResult claim(OperationId id, long expectedVersion, ConcurrencyLimits limits, Instant at) {
        Optional<OperationRow> found = operations.findById(id.value()).filter(stored -> stored.state() == OperationState.QUEUED && stored.version() == expectedVersion);
        if (found.isEmpty()) {
            return new ClaimResult.NotQueued();
        }
        OperationRow row = found.orElseThrow();
        TargetId target = new TargetId(row.targetId());
        String targetScope = TARGET_SCOPE_PREFIX + target.value();
        int globalSlot = freeSlot(GLOBAL_SCOPE, limits.globalConcurrency().value());
        if (globalSlot == 0) {
            return new ClaimResult.Saturated(SaturationReason.GLOBAL_CONCURRENCY);
        }
        int targetSlot = freeSlot(targetScope, limits.concurrencyOf(target).value());
        if (targetSlot == 0) {
            return new ClaimResult.Saturated(SaturationReason.TARGET_CONCURRENCY);
        }
        if (operations.countLiveUnknown() >= limits.unknownBudgetLimit().value()) {
            return new ClaimResult.Saturated(SaturationReason.UNKNOWN_BUDGET);
        }
        Operation queued = storage.load(row);
        Operation claimed = queued.claim(at);
        try {
            nested.executeWithoutResult(status -> {
                aggregates.insert(new OperationSlotRow(GLOBAL_SCOPE, globalSlot, row.id()));
                aggregates.insert(new OperationSlotRow(targetScope, targetSlot, row.id()));
                if (row.conflictKey() != null) {
                    aggregates.insert(new OperationFenceRow(row.targetId(), row.targetRevision(), digester.digestUtf8(row.conflictKey()).hex(), row.id()));
                }
                storage.persist(row, claimed, expectedVersion);
            });
        } catch (DuplicateKeyException e) {
            // Another claim took the same slot number or the same conflict key; the nested transaction is rolled back, nothing is held.
            return new ClaimResult.Contended();
        } catch (RequestRefusedException e) {
            if (e.code() == OperationErrorCode.OPERATION_VERSION_CONFLICT) {
                // The operation changed between the read above and the version check (cancelled, expired or claimed by another call).
                return new ClaimResult.NotQueued();
            }
            throw e;
        }
        return new ClaimResult.Claimed(claimed);
    }

    /** The smallest slot number from 1 to {@code limit} that is not taken in the scope, or 0 when every slot of the limit is taken. */
    private int freeSlot(String scope, int limit) {
        List<OperationSlotRow> taken = slots.findByScopeOrderBySlotNoAsc(scope);
        int candidate = 1;
        for (OperationSlotRow row : taken) {
            if (row.slotNo() == candidate) {
                candidate++;
            } else if (row.slotNo() > candidate) {
                break;
            }
        }
        return candidate <= limit ? candidate : 0;
    }
}
