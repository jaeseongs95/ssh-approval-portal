package io.github.jaeseongs95.portal.app.audit;

import com.fasterxml.jackson.annotation.JsonValue;

/** What an audit line records; the wire value is the 2.x {@code action} string (lower case, hyphenated). */
public enum AuditAction {
    SUBMITTED("submitted"),
    DENIED("denied"),
    EXECUTION_QUEUED("execution-queued"),
    /** The owner's operation is about to cross to the target (2.x approval-queue.mjs:256, an owner start). */
    APPROVED("approved"),
    /** An operation started by the server's policy is about to cross to the target (2.x approval-queue.mjs:256). */
    POLICY_EXECUTION_STARTED("policy-execution-started"),
    /** The final audit of an operation: 2.x wrote the state name as the action (approval-queue.mjs:228). */
    COMPLETED("completed"),
    FAILED("failed"),
    CANCELLED("cancelled"),
    UNKNOWN("unknown"),
    EXPIRED("expired"),
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
