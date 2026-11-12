package io.github.jaeseongs95.portal.domain.failure;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/** Why an operation was not dispatched, a fixed vocabulary (2.x dispatch-failure.mjs:3). The wire value is the lowercase name, for example {@code policy_changed}. */
public enum DispatchReason {
    UNKNOWN, MAINTENANCE, REQUEST_STATE, AUTHORITY, INVALID_COMMAND, PRIVATE_PLAN, TARGET_CHANGED, POLICY_CHANGED, POLICY_DENIED, PLAN_EXPIRED, BUSY, QUEUE_FULL,
    CLAIM_FAILED, AUDIT_FAILED, PERSISTENCE_FAILED;

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
