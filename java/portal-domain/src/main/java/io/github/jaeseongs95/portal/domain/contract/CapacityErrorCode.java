package io.github.jaeseongs95.portal.domain.contract;

/**
 * Request admission and runtime capacity. {@link #REQUEST_CAPACITY_EXCEEDED} is the one code that 3.0 adds to the 2.x vocabulary (stage 2 design, decision D-07):
 * 2.x answered a full approval-request store with the code-less text "Queue full" (approval-queue.mjs:52); a full request store, a full execution queue and a lost
 * transport are three different facts and each has its own code (defect D-0038).
 */
public enum CapacityErrorCode implements ErrorCode {
    REQUEST_QUEUE_CLOSED, REQUEST_WAIT_LIMIT, REQUEST_ABORTED, REQUEST_QUEUE_TIMEOUT, REQUEST_QUEUE_FULL, EXECUTION_QUEUE_FULL, INVALID_CAPACITY_STATE,
    INVALID_CAPACITY_TARGETS, INVALID_CAPACITY_TARGET, INVALID_CAPACITY_FIELDS, UNKNOWN_CAPACITY_TARGET, CAPACITY_REVISION_CONFLICT, REQUEST_CAPACITY_EXCEEDED;

    /** A full queue empties; the new code is the same kind of "full" as {@link #REQUEST_QUEUE_FULL} (approval-queue.mjs:52 had no code for it). */
    @Override
    public boolean retryableByDefault() {
        return this == REQUEST_QUEUE_FULL || this == REQUEST_CAPACITY_EXCEEDED;
    }

    /** Admission and capacity answers are given before a request is accepted. */
    @Override
    public ExecutionAttempt attemptByDefault() {
        return ExecutionAttempt.NOT_ATTEMPTED;
    }
}
