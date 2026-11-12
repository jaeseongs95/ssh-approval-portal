package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code operationData.remoteCleanup} on the wire (public-contract.mjs:44). */
public enum RemoteCleanupWire {
    CONFIRMED("confirmed"), UNCONFIRMED("unconfirmed");

    private final String wire;

    RemoteCleanupWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
