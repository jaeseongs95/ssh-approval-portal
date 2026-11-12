package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code gui.status} on the wire (public-contract.mjs:50): {@code configured} is not an opened or verified desktop. */
public enum GuiStatusWire {
    DISABLED("disabled"), CONFIGURED("configured"), BACKEND_UNAVAILABLE("backend_unavailable");

    private final String wire;

    GuiStatusWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
