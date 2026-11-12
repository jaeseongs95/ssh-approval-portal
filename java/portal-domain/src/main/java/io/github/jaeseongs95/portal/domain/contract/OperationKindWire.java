package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code operationData.kind} on the wire (public-contract.mjs:41). The contract's vocabulary, kept apart from the domain enum so that a domain change cannot move the wire. */
public enum OperationKindWire {
    COMMAND("command"), SOURCE("source"), UPLOAD("upload"), DOWNLOAD("download");

    private final String wire;

    OperationKindWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
