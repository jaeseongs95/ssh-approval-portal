package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code closeData.sessionState} on the wire (public-contract.mjs:279): what became of the desktop session after the lease was closed. */
public enum DesktopSessionStateWire {
    TERMINATED("terminated"), PRESERVED("preserved"), UNKNOWN("unknown");

    private final String wire;

    DesktopSessionStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
