package io.github.jaeseongs95.portal.domain.contract;

/** Failures of the operation journal and the scheduler: capacity, version conflicts, impossible transitions, invalid records. */
public enum OperationErrorCode implements ErrorCode {
    OPERATION_QUEUE_FULL, OPERATION_RECONCILIATION_CAPACITY, OPERATION_ADMISSION_CLOSED, INVALID_OPERATION_RECORD, INVALID_OPERATION_REQUEST_KEY,
    INVALID_OPERATION_OBSERVER, OPERATION_OBSERVER_CAPACITY, OPERATION_OBSERVER_ABORTED, OPERATION_NOTIFICATION_FAILED, OPERATION_STORE_FAILED,
    OPERATION_OUTCOME_PERSISTENCE_FAILED, OPERATION_DISPATCH_PERSISTENCE_FAILED, OPERATION_CAPACITY, OPERATION_TOO_LARGE, OPERATION_VERSION_CONFLICT,
    OPERATION_CONTRACT_IMMUTABLE, INVALID_OPERATION_TRANSITION, OPERATION_PRESERVATION_NOT_IDLE, INVALID_OPERATION_FILTER, INVALID_OPERATION_LIMIT,
    INVALID_OPERATION_STATE, INVALID_OPERATION_CLAIM_LIMIT, INVALID_OPERATION_PORT;

    /** The scheduler's own refusals carry {@code retryable: true} for exactly these two (operation-scheduler.mjs:3). */
    @Override
    public boolean retryableByDefault() {
        return this == OPERATION_QUEUE_FULL || this == OPERATION_RECONCILIATION_CAPACITY;
    }

    /** The scheduler marks every refusal it raises {@code accepted: false} (operation-scheduler.mjs:3); a failed store or notification is after the fact. */
    @Override
    public ExecutionAttempt attemptByDefault() {
        boolean afterAcceptance = this == OPERATION_STORE_FAILED || this == OPERATION_OUTCOME_PERSISTENCE_FAILED || this == OPERATION_DISPATCH_PERSISTENCE_FAILED
            || this == OPERATION_NOTIFICATION_FAILED || this == OPERATION_OBSERVER_ABORTED || this == OPERATION_CONTRACT_IMMUTABLE
            || this == OPERATION_VERSION_CONFLICT || this == INVALID_OPERATION_TRANSITION || this == INVALID_OPERATION_RECORD;
        return afterAcceptance ? ExecutionAttempt.UNKNOWN : ExecutionAttempt.NOT_ATTEMPTED;
    }
}
