package io.github.jaeseongs95.portal.domain.contract;

import java.io.Serializable;

/**
 * An error code of the public contract. The wire value is the constant name itself (2.x already used UPPER_SNAKE values), so no mapping exists between the
 * Java name and the wire. The categories are closed: one enum per kind of failure, and a value lives in exactly one of them. The one place that turns a code into
 * an HTTP or MCP answer is a complete {@code switch} over this interface, so a code that is added to a category and not handled there fails the build
 * (Principles 3.4).
 *
 * <p>It is {@link Serializable} because {@link RequestRefusedException} is: an enum is serializable and the interface says so for the field type.
 */
public sealed interface ErrorCode extends Serializable
    permits RequestErrorCode, OperationErrorCode, ArtifactErrorCode, HistoryErrorCode, CapacityErrorCode, DesktopErrorCode, TransferErrorCode, ExecutionErrorCode {

    /** The wire value; an enum supplies this method through {@link Enum#name()}. */
    String name();

    /**
     * Whether the same request may succeed later without a change: a full queue or a maintenance window (public-contract.mjs:165, operation-scheduler.mjs:3).
     * A throw site that knows better passes the value to {@link RequestRefusedException} itself.
     */
    default boolean retryableByDefault() {
        return false;
    }

    /**
     * What the caller may assume about the remote effect when the throw site says nothing. A refusal before admission never touched the target
     * ({@link ExecutionAttempt#NOT_ATTEMPTED}); everything that can happen after dispatch is {@link ExecutionAttempt#UNKNOWN} (public-contract.mjs:166).
     */
    default ExecutionAttempt attemptByDefault() {
        return ExecutionAttempt.UNKNOWN;
    }
}
