package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code executionData.outputState} on the wire (public-contract.mjs:29): whether the captured output is partial or complete. */
public enum OutputStateWire {
    PARTIAL("partial"), COMPLETE("complete");

    private final String wire;

    OutputStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
