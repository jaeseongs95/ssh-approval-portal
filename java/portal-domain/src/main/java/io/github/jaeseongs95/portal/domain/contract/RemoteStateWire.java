package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code executionData.remoteState} on the wire (public-contract.mjs:25). */
public enum RemoteStateWire {
    NOT_DISPATCHED("not_dispatched"), EXITED("exited"), UNKNOWN("unknown");

    private final String wire;

    RemoteStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
