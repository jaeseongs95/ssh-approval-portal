package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** The version of the public contract. The envelope always carries the constant {@code "2.0"} (public-contract.mjs:73, {@code contractVersion: z.literal(...)}). */
public enum ContractVersion {
    V2_0("2.0");

    private final String wire;

    ContractVersion(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
