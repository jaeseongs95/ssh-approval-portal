package io.github.jaeseongs95.portal.domain.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Objects;

/**
 * The {@code data} of {@code targets} (public-contract.mjs:51-60, {@code targetData}): the targets, the default one, the limits and where the owner approves. A null
 * {@code defaultTarget} is the wire null (null = wire null): no target is the default.
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record TargetsData(List<TargetData> targets, String defaultTarget, LimitsData limits, ApprovalData approval) {

    public TargetsData {
        targets = List.copyOf(targets);
        WireFormat.TARGET.requireOrNull(defaultTarget, "defaultTarget");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(approval, "approval");
    }
}
