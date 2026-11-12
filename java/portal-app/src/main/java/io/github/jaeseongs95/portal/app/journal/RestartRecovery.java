package io.github.jaeseongs95.portal.app.journal;

import java.time.Instant;
import java.util.List;

import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * What the start of the application does to the journal: every operation that was in flight is closed in one transaction (design 2.3, T18 to T21).
 * {@code ACCEPTED}, {@code EVALUATING}, {@code STARTING}, {@code RUNNING} and {@code TERMINATING} become {@code UNKNOWN}, {@code PENDING} becomes {@code EXPIRED};
 * the recovery reason is {@code BRIDGE_RESTART}. A {@code QUEUED} operation was never tried and stays queued (the domain decides, case B-200). An operation whose outcome
 * is unknown is never sent again.
 */
public interface RestartRecovery {

    /** The operations that were changed, in their new state. A second call changes nothing and returns an empty list. */
    List<Operation> recoverAfterRestart(Instant at);
}
