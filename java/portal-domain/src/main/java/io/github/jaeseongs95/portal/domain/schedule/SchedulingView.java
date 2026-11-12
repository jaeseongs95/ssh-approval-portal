package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Everything the scheduler judges on, read once from the store: the operations that wait, how many run in total and per target, how many of unknown result wait
 * for the owner (without the ones imported from a 2.x history), when each target last started an operation, which resources are fenced, the limits, and the moment.
 * The scheduler holds no state of its own, so the same view always gives the same decision (stage 2 design 3.2).
 *
 * @param queued the waiting operations, in any order; their place in line is their ready sequence
 * @param activeTotal operations that hold an execution slot
 * @param activeByTarget operations that hold a slot, per target; a target that is not listed has none
 * @param liveUnknown operations of unknown result that wait for the owner, without imported history
 * @param lastStartedAt the instant each target last started an operation; a target that is not listed never did
 * @param fenced the resources fenced by a running or unknown operation
 * @param limits the limits in force
 * @param now the moment of the decision
 */
public record SchedulingView(List<QueuedOperation> queued, int activeTotal, Map<TargetId, Integer> activeByTarget, int liveUnknown, Map<TargetId, Instant> lastStartedAt,
                             Set<FenceKey> fenced, ConcurrencyLimits limits, Instant now) {

    public SchedulingView {
        queued = List.copyOf(queued);
        activeByTarget = Map.copyOf(activeByTarget);
        lastStartedAt = Map.copyOf(lastStartedAt);
        fenced = Set.copyOf(fenced);
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(now, "now");
        if (activeTotal < 0 || liveUnknown < 0 || activeByTarget.values().stream().anyMatch(count -> count < 0)) {
            throw new IllegalArgumentException("A count is not negative");
        }
    }

    /** The operations that hold a slot on the target. */
    public int activeOn(TargetId target) {
        return activeByTarget.getOrDefault(target, 0);
    }

    /** The operations that wait for a place on the target. */
    public int queuedOn(TargetId target) {
        return (int) queued.stream().filter(entry -> entry.targetId().equals(target)).count();
    }
}
