package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code gui.backend} on the wire (public-contract.mjs:49). A display-only value: the desktop backends themselves live in the desktop module. */
public enum GuiBackendWire {
    RFB("rfb"), XVNC("xvnc"), RDP("rdp");

    private final String wire;

    GuiBackendWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
