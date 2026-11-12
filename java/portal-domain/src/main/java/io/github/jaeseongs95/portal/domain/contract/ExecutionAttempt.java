package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Whether the remote effect of a request may have happened. The wire carries a boolean or the text {@code "unknown"} (public-contract.mjs:73,
 * {@code executionAttempted}): {@code false} when nothing reached the target, {@code true} when it did, {@code "unknown"} when the caller cannot tell and must not
 * replay the request.
 */
public enum ExecutionAttempt {
    NOT_ATTEMPTED(Boolean.FALSE),
    ATTEMPTED(Boolean.TRUE),
    UNKNOWN("unknown");

    private final Object wire;

    ExecutionAttempt(Object wire) {
        this.wire = wire;
    }

    /** The value on the wire: a {@link Boolean} or the {@link String} {@code "unknown"}. */
    @JsonValue
    public Object wire() {
        return wire;
    }
}
