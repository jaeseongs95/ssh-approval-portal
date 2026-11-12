package io.github.jaeseongs95.portal.domain.command;

import java.util.List;
import java.util.Objects;

/** What the catalogue says about a name it does not know: nothing about its capabilities, and that the owner must check it before registering it. */
public record DefaultRisk(RiskLevel riskLevel, List<RiskCapability> capabilities, String reason) {

    public DefaultRisk {
        Objects.requireNonNull(riskLevel, "riskLevel");
        Objects.requireNonNull(reason, "reason");
        capabilities = List.copyOf(capabilities);
    }
}
