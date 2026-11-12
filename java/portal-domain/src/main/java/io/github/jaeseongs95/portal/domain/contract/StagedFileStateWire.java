package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code stagedFile.state} on the wire (public-contract.mjs:68). */
public enum StagedFileStateWire {
    STAGING("staging"), READY("ready"), EXPIRED("expired"), CONSUMING("consuming"), MOVED("moved"), REMOVED("removed");

    private final String wire;

    StagedFileStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
