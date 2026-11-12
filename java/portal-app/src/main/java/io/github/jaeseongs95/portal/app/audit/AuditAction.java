package io.github.jaeseongs95.portal.app.audit;

import com.fasterxml.jackson.annotation.JsonValue;

/** What an audit line records; the wire value is the 2.x {@code action} string (lower case, hyphenated). */
public enum AuditAction {
    SUBMITTED("submitted"),
    DENIED("denied"),
    EXECUTION_QUEUED("execution-queued"),
    COMMAND_DECISION("command-decision"),
    COMMAND_POLICY_CHANGE_REQUESTED("command-policy-change-requested"),
    COMMAND_POLICY_REVIEWED("command-policy-reviewed"),
    CAPACITY_UPDATED("capacity-updated"),
    MAINTENANCE_RESERVED("maintenance-reserved"),
    MAINTENANCE_RELEASED("maintenance-released");

    private final String wire;

    AuditAction(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
