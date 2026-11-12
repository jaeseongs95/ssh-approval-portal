package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code operationData.remoteOutcome} on the wire (public-contract.mjs:43): whether the remote effect did not start, completed or cannot be told. */
public enum RemoteOutcomeWire {
    NOT_STARTED("not_started"), COMPLETED("completed"), UNKNOWN("unknown");

    private final String wire;

    RemoteOutcomeWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
