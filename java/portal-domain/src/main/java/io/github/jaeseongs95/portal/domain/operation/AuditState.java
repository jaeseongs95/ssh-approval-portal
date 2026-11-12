package io.github.jaeseongs95.portal.domain.operation;

/** Whether the final audit record of the operation was written. After {@link #FAILED} the operation must not be retried automatically (2.x approval-queue.mjs:225). */
public enum AuditState {
    NONE, FAILED
}
