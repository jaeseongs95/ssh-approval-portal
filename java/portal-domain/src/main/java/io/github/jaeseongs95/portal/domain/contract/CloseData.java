package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * The {@code data} of {@code desktop-close} (public-contract.mjs:279, {@code closeData}). {@code closed} is always {@code true} and {@code logout} always
 * {@code false}: the contract says the lease ended and the user was not logged out; whether the cleanup worked is {@code releaseSent}, {@code cleanupError} and
 * {@code sessionState}.
 *
 * <p>A null {@code cleanupError} is the wire null (null = wire null): there was no error. A null {@code sessionState} is not written at all: the baseline's
 * {@code sessionState} is optional and never null.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record CloseData(String sessionId, boolean closed, boolean releaseSent, boolean logout, @JsonInclude(JsonInclude.Include.NON_NULL) DesktopSessionStateWire sessionState,
                        String cleanupError) {

    public CloseData {
        WireFormat.SESSION_ID.require(sessionId, "sessionId");
        if (!closed) {
            throw new IllegalArgumentException("The contract promises closed is true");
        }
        if (logout) {
            throw new IllegalArgumentException("The contract promises logout is false");
        }
    }
}
