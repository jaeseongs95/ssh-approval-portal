package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/** How much care a command name calls for, as the catalogue words it. A guidance level for the owner who registers names, not a probability of harm. */
public enum RiskLevel {
    LOW("low"),
    MODERATE("moderate"),
    HIGH("high"),
    UNKNOWN("unknown");

    private final String wire;

    RiskLevel(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
