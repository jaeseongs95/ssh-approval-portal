package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.util.Objects;
import java.util.Set;

/**
 * What the scheduler needs to know of an operation that waits in the queue: which one (with the version the claim is made against), where, what it fences, when it
 * expires, and its place in line. The place ({@code readySequence}) is assigned by the store when the operation becomes queued; a lower number is earlier.
 */
public record QueuedOperation(OperationId id, long version, TargetId targetId, TargetRevision targetRevision, ConflictKey conflictKey, Deadline expiry,
                              long readySequence) {

    public QueuedOperation {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(conflictKey, "conflictKey");
        Objects.requireNonNull(expiry, "expiry");
    }

    /** The queue entry of a queued operation at its place in line. */
    public static QueuedOperation of(Operation operation, long readySequence) {
        Objects.requireNonNull(operation, "operation");
        if (operation.state() != OperationState.QUEUED) {
            throw new IllegalArgumentException("Only a queued operation waits in the queue");
        }
        return new QueuedOperation(operation.id(), operation.version(), operation.targetId(), operation.targetRevision(), operation.conflictKey(), operation.expiry(),
            readySequence);
    }

    /** True when the entry fences a resource that is in the fenced set. */
    public boolean isFencedBy(Set<FenceKey> fenced) {
        return switch (conflictKey) {
            case ConflictKey.None none -> false;
            case ConflictKey.Of key -> fenced.contains(new FenceKey(targetId, targetRevision, key.value()));
        };
    }
}
