package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code stagedFile.operations[].action} on the wire (public-contract.mjs:70): a staged file is copied to the target or moved there. */
public enum FilePlacementWire {
    COPY("copy"), MOVE("move");

    private final String wire;

    FilePlacementWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
