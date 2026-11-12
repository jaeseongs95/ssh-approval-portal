package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code transferStatus.state} on the wire (public-contract.mjs:64): the state of an agent byte upload. */
public enum TransferStateWire {
    STAGING("staging"), READY("ready"), EXPIRED("expired"), SUBMITTED("submitted");

    private final String wire;

    TransferStateWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
