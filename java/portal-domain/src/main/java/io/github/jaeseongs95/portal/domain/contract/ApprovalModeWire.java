package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code operationData.approvalMode} on the wire (public-contract.mjs:42). */
public enum ApprovalModeWire {
    OWNER("owner"), AUTOMATIC("automatic");

    private final String wire;

    ApprovalModeWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
