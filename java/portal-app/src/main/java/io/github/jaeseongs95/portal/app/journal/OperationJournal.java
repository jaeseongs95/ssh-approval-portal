package io.github.jaeseongs95.portal.app.journal;

import java.util.List;
import java.util.Optional;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;

/**
 * The durable journal of every operation: intake and transitions (2.x {@code operation-store.mjs}). Consumers are the use cases; the implementation is a
 * storage adapter. The journal never decides whether a transition is allowed: {@link Operation} does that, the journal only stores the result atomically.
 */
public interface OperationJournal {

    /**
     * Stores a new operation. The request key is unique: the same key with the same contract returns {@link JournalInsert.Existing}, the same key with another contract
     * throws {@code RequestRefusedException(OPERATION_KEY_CONFLICT)}. The implementation makes the id and the time (an {@code OperationIdGenerator} and the one
     * {@code Clock}) and writes the first event in the same transaction. A refused intake because the journal is full ({@code OPERATION_CAPACITY}) is also an exception.
     */
    JournalInsert accept(NewOperation spec);

    /** {@code Optional} here has the one meaning "no such operation". */
    Optional<Operation> find(OperationId id);

    Optional<Operation> findByRequestKey(RequestKey key);

    /**
     * Compare-and-set: stores {@code next} when the stored version is {@code expectedVersion}, writes the event of the new state and releases or takes the concurrency
     * slots that the new state implies, all in one transaction. Another writer's change throws {@code RequestRefusedException(OPERATION_VERSION_CONFLICT)}; the
     * caller reads again and decides again.
     */
    Operation save(Operation next, long expectedVersion);

    /** The transitions of one operation in version order. */
    List<OperationEvent> events(OperationId id);
}
