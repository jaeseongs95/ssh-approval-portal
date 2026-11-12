package io.github.jaeseongs95.portal.app.operation;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * What an observer gets: the operation as it is, and whether it waited and nothing changed.
 *
 * @param operation the operation after the wait
 * @param waitTimedOut true when the observer waited for a change and the time ran out first
 */
public record Observation(Operation operation, boolean waitTimedOut) {

    public Observation {
        Objects.requireNonNull(operation, "operation");
    }
}
