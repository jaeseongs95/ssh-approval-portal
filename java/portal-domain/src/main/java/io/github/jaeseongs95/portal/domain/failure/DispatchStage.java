package io.github.jaeseongs95.portal.domain.failure;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.EnumSet;
import java.util.Locale;
import java.util.Set;

/**
 * The step before dispatch at which an operation was stopped (2.x dispatch-failure.mjs:4). The wire value is the lowercase name. Every stage knows the reasons
 * it can be stopped for, so a pair that no caller in 2.x ever produced (a persistence failure at the policy guard) is refused when a
 * {@link DispatchFailure} is built; 2.x only checked that both values were in their lists.
 */
public enum DispatchStage {
    UNKNOWN(DispatchReason.UNKNOWN),
    MAINTENANCE(DispatchReason.MAINTENANCE),
    REQUEST_STATE(DispatchReason.REQUEST_STATE),
    AUTHORITY(DispatchReason.AUTHORITY),
    COMMAND_VALIDATION(DispatchReason.INVALID_COMMAND),
    COMMAND_GUARD(DispatchReason.UNKNOWN),
    FILE_GUARD(DispatchReason.UNKNOWN, DispatchReason.AUTHORITY),
    SOURCE_PLAN(DispatchReason.PRIVATE_PLAN),
    TARGET_GUARD(DispatchReason.TARGET_CHANGED),
    CLI_GUARD(DispatchReason.UNKNOWN, DispatchReason.PRIVATE_PLAN, DispatchReason.PLAN_EXPIRED),
    POLICY_GUARD(DispatchReason.UNKNOWN, DispatchReason.POLICY_CHANGED, DispatchReason.POLICY_DENIED),
    BUSY_CHECK(DispatchReason.BUSY),
    EXECUTION_QUEUE(DispatchReason.QUEUE_FULL),
    EXECUTION_CLAIM(DispatchReason.CLAIM_FAILED),
    DECISION_PERSISTENCE(DispatchReason.PERSISTENCE_FAILED),
    DECISION_AUDIT(DispatchReason.AUDIT_FAILED),
    EVALUATION_PERSISTENCE(DispatchReason.PERSISTENCE_FAILED),
    START_AUDIT(DispatchReason.AUDIT_FAILED),
    START_PERSISTENCE(DispatchReason.PERSISTENCE_FAILED);

    private final Set<DispatchReason> reasons;

    DispatchStage(DispatchReason first, DispatchReason... more) {
        this.reasons = EnumSet.of(first, more);
    }

    /** True when an operation can be stopped at this stage for the reason. */
    public boolean accepts(DispatchReason reason) {
        return reasons.contains(reason);
    }

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
