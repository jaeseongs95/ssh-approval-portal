package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code gui.lifecycle} and {@code session.lifecycle} on the wire (public-contract.mjs:50, 266): an attached desktop or one the portal starts and stops. */
public enum GuiLifecycleWire {
    ATTACHED("attached"), MANAGED("managed");

    private final String wire;

    GuiLifecycleWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
