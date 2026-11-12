package io.github.jaeseongs95.portal.domain.operation;

import java.time.Instant;
import java.util.Objects;

/** One row of an operation's history: the transition that produced {@code version}, the state it reached and when. Every transition leaves exactly one (2.x operation-store.mjs:145). */
public record OperationEvent(long version, OperationState state, Instant occurredAt) {

    public OperationEvent {
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(occurredAt, "occurredAt");
        if (version < 1) {
            throw new IllegalArgumentException("A version starts at 1");
        }
    }
}
