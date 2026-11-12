package io.github.jaeseongs95.portal.domain.command;

import java.util.List;
import java.util.Objects;

/**
 * What the catalogue says about one command name: what it is for, its category, the care it calls for, what it can do and why. Arguments are not scored: the
 * entry describes the name, never one use of it.
 */
public record RiskEntry(String description, String category, RiskLevel riskLevel, List<RiskCapability> capabilities, String reason) {

    public RiskEntry {
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(category, "category");
        Objects.requireNonNull(riskLevel, "riskLevel");
        Objects.requireNonNull(reason, "reason");
        capabilities = List.copyOf(capabilities);
    }
}
