package io.github.jaeseongs95.portal.app.event;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * An operation moved to a new version. It is the one wake-up of the application: whoever waits for a change (an observer, the dispatcher) is woken by this event
 * after the transaction that wrote the change has committed, so nothing polls (stage 3 design 3.2 D3).
 *
 * @param id the operation
 * @param state the state it reached
 * @param version the version it reached
 */
public record OperationChanged(OperationId id, OperationState state, long version) {

    public OperationChanged {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(state, "state");
    }

    /** The event of the operation as it stands. */
    public static OperationChanged of(Operation operation) {
        return new OperationChanged(operation.id(), operation.state(), operation.version());
    }
}
