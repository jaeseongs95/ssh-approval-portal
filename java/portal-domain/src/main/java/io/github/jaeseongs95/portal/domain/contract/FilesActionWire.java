package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code filesData.action} on the wire (public-contract.mjs:97): the four actions of the {@code files} tool. */
public enum FilesActionWire {
    STAT("stat"), COPY("copy"), MOVE("move"), REMOVE("remove");

    private final String wire;

    FilesActionWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
