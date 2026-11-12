package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code executionData.phase} on the wire (public-contract.mjs:24): the contract has the single literal {@code "settled"}, or null. */
public enum ExecutionPhaseWire {
    SETTLED("settled");

    private final String wire;

    ExecutionPhaseWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
