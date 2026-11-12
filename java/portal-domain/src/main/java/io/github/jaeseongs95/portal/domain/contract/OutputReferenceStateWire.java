package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code outputReference.state} on the wire (public-contract.mjs:17). */
public enum OutputReferenceStateWire {
    PENDING("pending"), READY("ready"), UNAVAILABLE("unavailable"), EXPIRED("expired");

    private final String wire;

    OutputReferenceStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
