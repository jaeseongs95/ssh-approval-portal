package io.github.jaeseongs95.portal.app.artifact;

/**
 * Why an artifact stops being pinned (design 1.3, S3-AR-07): the operation that depended on it reached a final state, so the artifact goes back to the expiry
 * calculation. It is logged, not stored.
 */
public enum UnpinReason {
    /** The operation settled (completed, failed, cancelled, unknown or expired). */
    OPERATION_SETTLED,
    /** The operation was refused or denied before it ran. */
    OPERATION_REFUSED
}
