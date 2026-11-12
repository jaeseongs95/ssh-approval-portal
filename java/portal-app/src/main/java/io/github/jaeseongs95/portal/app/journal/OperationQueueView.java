package io.github.jaeseongs95.portal.app.journal;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.SchedulingView;

/**
 * The read model the scheduler's decision is made from (2.x {@code operation-store.mjs:236-258} counts and lists). Read only; the decision itself is the pure
 * {@code OperationScheduler} of portal-domain, and the claim that follows it is {@link ClaimStore}'s.
 */
public interface OperationQueueView {

    /**
     * What the scheduler needs in one answer: the queued operations in ready order (at most {@code queuedLimit}), the active count of the whole system and of the
     * targets that have a queued operation, the live unknown count (imported 2.x rows left out), the latest start of those targets, and the conflict keys of the queued
     * operations that a live operation holds. The values are read in one transaction.
     */
    SchedulingView schedulingView(ConcurrencyLimits limits, Instant now, int queuedLimit);

    StateCounts counts();

    /** Operations in the given states, oldest first, at most {@code limit}. */
    List<Operation> inStates(Set<OperationState> states, TargetFilter filter, int limit);
}
