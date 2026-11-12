package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code executionData.signalDelivery} on the wire (public-contract.mjs:27): {@code requested} is not a confirmed remote termination. */
public enum SignalDeliveryWire {
    REQUESTED("requested"), UNSUPPORTED("unsupported");

    private final String wire;

    SignalDeliveryWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
