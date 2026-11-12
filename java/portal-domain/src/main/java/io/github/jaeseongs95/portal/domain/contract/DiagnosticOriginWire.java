package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonValue;

/** {@code diagnostic.origin} on the wire (public-contract.mjs:22): the refusal came from the portal's policy or from the target's operating system. */
public enum DiagnosticOriginWire {
    POLICY("policy"), OS("os");

    private final String wire;

    DiagnosticOriginWire(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
