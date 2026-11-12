package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.approval.AdmissionDecision;
import io.github.jaeseongs95.portal.domain.approval.CapacityKind;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Decides what the execution queue does next. It only judges: the store owns the queue and makes the claim in a transaction, a dispatcher asks and acts. It has no
 * state, so it is deterministic: the same {@link SchedulingView} gives the same {@link SchedulingDecision} on any instance, after a restart, and when two
 * dispatchers ask at once (the claim then fails for one of them instead of running an operation twice).
 *
 * <p>Fairness is computed from data instead of kept in a ring (2.x kept the order of ready targets in a mutable list, operation-scheduler.mjs:12, and stage 2 design
 * 3.2 turns it into data): a target that never started an operation goes first, then the target that started its last operation longest ago; the places in line
 * break a tie. Inside a target the order is first come, first served. The result is the same round robin 2.x showed (case B-186).
 */
public final class OperationScheduler {

    /**
     * The next step for the queue. Operations whose deadline has passed are expired first; then the first claimable operation is chosen. A target that has reached a
     * limit is skipped; inside a target an operation whose resource is fenced is skipped and the next one is tried, because a quarantined resource must not freeze the
     * other resources of the target (2.x operation-scheduler.mjs:94-101).
     */
    public SchedulingDecision select(SchedulingView view) {
        Objects.requireNonNull(view, "view");
        Instant now = view.now();
        List<OperationId> expired = view.queued().stream().filter(entry -> entry.expiry().isReached(now)).map(QueuedOperation::id).toList();
        if (!expired.isEmpty()) {
            return new SchedulingDecision.ExpireQueued(expired);
        }
        if (view.queued().isEmpty()) {
            return new SchedulingDecision.Idle();
        }
        Map<TargetId, List<QueuedOperation>> byTarget = new LinkedHashMap<>();
        view.queued().stream().sorted(Comparator.comparingLong(QueuedOperation::readySequence))
            .forEach(entry -> byTarget.computeIfAbsent(entry.targetId(), target -> new ArrayList<>()).add(entry));
        Comparator<TargetId> fairness = Comparator.<TargetId, Boolean>comparing(target -> view.lastStartedAt().containsKey(target))
            .thenComparing(target -> view.lastStartedAt().getOrDefault(target, Instant.MIN))
            .thenComparingLong(target -> byTarget.get(target).get(0).readySequence());
        List<TargetId> order = new ArrayList<>(byTarget.keySet());
        order.sort(fairness);
        List<SaturationReason> blockedBy = new ArrayList<>();
        for (TargetId target : order) {
            Optional<SaturationReason> limit = limitReached(target, view);
            if (limit.isPresent()) {
                blockedBy.add(limit.orElseThrow());
                continue;
            }
            for (QueuedOperation candidate : byTarget.get(target)) {
                if (candidate.isFencedBy(view.fenced())) {
                    blockedBy.add(SaturationReason.CONFLICT_FENCE);
                    continue;
                }
                return new SchedulingDecision.Claim(candidate.id(), candidate.version());
            }
        }
        return new SchedulingDecision.Saturated(blockedBy.get(0));
    }

    /**
     * Whether an operation of the target may enter the queue now: the queue has room in total and on the target, and the budget for operations of unknown result is not
     * used up. The operations that wait and the unknown ones are counted from the view.
     */
    public AdmissionDecision admitToQueue(TargetId target, SchedulingView view) {
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(view, "view");
        ConcurrencyLimits limits = view.limits();
        if (view.queued().size() >= limits.queueCapacity().value()) {
            return new AdmissionDecision.RejectedCapacity(CapacityKind.EXECUTION_QUEUE);
        }
        if (view.queuedOn(target) >= limits.queueCapacityOf(target).value()) {
            return new AdmissionDecision.RejectedCapacity(CapacityKind.TARGET_QUEUE);
        }
        if (view.liveUnknown() >= limits.unknownBudgetLimit().value()) {
            return new AdmissionDecision.RejectedCapacity(CapacityKind.RECONCILIATION);
        }
        return new AdmissionDecision.Admit();
    }

    private Optional<SaturationReason> limitReached(TargetId target, SchedulingView view) {
        ConcurrencyLimits limits = view.limits();
        if (view.activeTotal() >= limits.globalConcurrency().value()) {
            return Optional.of(SaturationReason.GLOBAL_CONCURRENCY);
        }
        if (view.activeOn(target) >= limits.concurrencyOf(target).value()) {
            return Optional.of(SaturationReason.TARGET_CONCURRENCY);
        }
        if ((long) view.activeTotal() + view.liveUnknown() >= limits.unknownBudgetLimit().value()) {
            return Optional.of(SaturationReason.UNKNOWN_BUDGET);
        }
        return Optional.empty();
    }
}
