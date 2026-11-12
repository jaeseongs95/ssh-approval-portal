package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code gui.actions[]} on the wire (public-contract.mjs:51): what an agent may do with the desktop. */
public enum GuiActionWire {
    OBSERVE("observe"), POINTER("pointer"), KEY("key"), TEXT("text");

    private final String wire;

    GuiActionWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
