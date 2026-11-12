package io.github.jaeseongs95.portal.domain.approval;

import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;

/**
 * Which limit refused a request. Each has its own error code, so a full request store, a full execution queue and an exhausted reconciliation budget are never one
 * message (defect D-0038; 2.x answered the first with the code-less text "Queue full", approval-queue.mjs:52).
 */
public enum CapacityKind {
    /** The approval store holds as many open requests as the request capacity allows. */
    REQUEST_STORE(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED),
    /** The execution queue holds as many operations as the queue capacity allows. */
    EXECUTION_QUEUE(OperationErrorCode.OPERATION_QUEUE_FULL),
    /** The execution queue holds as many operations of this target as its queue capacity allows. */
    TARGET_QUEUE(OperationErrorCode.OPERATION_QUEUE_FULL),
    /** Too many operations of unknown result wait for the owner; a new one is not queued until some are reconciled. */
    RECONCILIATION(OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY);

    private final ErrorCode errorCode;

    CapacityKind(ErrorCode errorCode) {
        this.errorCode = errorCode;
    }

    /** The contract error code of a request this limit refused. */
    public ErrorCode errorCode() {
        return errorCode;
    }
}
