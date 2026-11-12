package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code targets[].platform} on the wire (public-contract.mjs:53). */
public enum PlatformWire {
    LINUX("linux"), WINDOWS("windows");

    private final String wire;

    PlatformWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
