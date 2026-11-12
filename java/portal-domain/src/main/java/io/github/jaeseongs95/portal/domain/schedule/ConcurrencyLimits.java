package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The limits of the execution queue (2.x operation-scheduler.mjs:4): how many operations run at once, in total and per target, how many wait, in total and per
 * target, how many operations of unknown result may wait for the owner, and how many observers may wait for a change. A target may have limits of its own;
 * the others get the default. There is no upper bound but what an {@code int} holds (case B-198).
 *
 * <p>The budget for unknown operations follows the global concurrency unless it was set: it is the larger of 32 and the global concurrency, so a bridge that is
 * allowed many parallel operations does not stall on a small fixed budget (2.x operation-scheduler.mjs:22).
 *
 * @param globalConcurrency operations running at once, over all targets
 * @param targetConcurrency operations running at once on one target, unless the target has its own
 * @param targetConcurrencyOverrides the targets that have their own concurrency
 * @param queueCapacity operations waiting, over all targets
 * @param targetQueueCapacity operations waiting on one target, unless the target has its own
 * @param targetQueueOverrides the targets that have their own queue capacity
 * @param unknownBudget how the budget for unknown operations is set
 * @param observerCapacity observers that may wait for a change at once
 */
public record ConcurrencyLimits(Capacity globalConcurrency, Capacity targetConcurrency, Map<TargetId, Capacity> targetConcurrencyOverrides, Capacity queueCapacity,
                                Capacity targetQueueCapacity, Map<TargetId, Capacity> targetQueueOverrides, UnknownBudget unknownBudget, Capacity observerCapacity) {

    public static final int DEFAULT_GLOBAL_CONCURRENCY = 2;
    public static final int DEFAULT_TARGET_CONCURRENCY = 1;
    public static final int DEFAULT_QUEUE_CAPACITY = 32;
    public static final int DEFAULT_TARGET_QUEUE_CAPACITY = 32;
    public static final int DEFAULT_UNKNOWN_BUDGET = 32;
    public static final int DEFAULT_OBSERVER_CAPACITY = 256;

    public ConcurrencyLimits {
        Objects.requireNonNull(globalConcurrency, "globalConcurrency");
        Objects.requireNonNull(targetConcurrency, "targetConcurrency");
        Objects.requireNonNull(queueCapacity, "queueCapacity");
        Objects.requireNonNull(targetQueueCapacity, "targetQueueCapacity");
        Objects.requireNonNull(unknownBudget, "unknownBudget");
        Objects.requireNonNull(observerCapacity, "observerCapacity");
        targetConcurrencyOverrides = Map.copyOf(targetConcurrencyOverrides);
        targetQueueOverrides = Map.copyOf(targetQueueOverrides);
    }

    /** The limits of a new installation. */
    public static ConcurrencyLimits defaults() {
        return new ConcurrencyLimits(new Capacity(DEFAULT_GLOBAL_CONCURRENCY), new Capacity(DEFAULT_TARGET_CONCURRENCY), Map.of(), new Capacity(DEFAULT_QUEUE_CAPACITY),
            new Capacity(DEFAULT_TARGET_QUEUE_CAPACITY), Map.of(), new UnknownBudget.FollowsGlobal(), new Capacity(DEFAULT_OBSERVER_CAPACITY));
    }

    /** The concurrency of the target: its own when it has one, otherwise the default for a target. */
    public Capacity concurrencyOf(TargetId target) {
        return targetConcurrencyOverrides.getOrDefault(target, targetConcurrency);
    }

    /** The queue capacity of the target: its own when it has one, otherwise the default for a target. */
    public Capacity queueCapacityOf(TargetId target) {
        return targetQueueOverrides.getOrDefault(target, targetQueueCapacity);
    }

    /** The budget for unknown operations in force: the set one, or the larger of 32 and the global concurrency. */
    public Capacity unknownBudgetLimit() {
        return switch (unknownBudget) {
            case UnknownBudget.Explicit explicit -> explicit.capacity();
            case UnknownBudget.FollowsGlobal follows -> new Capacity(Math.max(DEFAULT_UNKNOWN_BUDGET, globalConcurrency.value()));
        };
    }

    public ConcurrencyLimits withGlobalConcurrency(Capacity capacity) {
        return new ConcurrencyLimits(capacity, targetConcurrency, targetConcurrencyOverrides, queueCapacity, targetQueueCapacity, targetQueueOverrides, unknownBudget,
            observerCapacity);
    }

    public ConcurrencyLimits withQueueCapacity(Capacity capacity) {
        return new ConcurrencyLimits(globalConcurrency, targetConcurrency, targetConcurrencyOverrides, capacity, targetQueueCapacity, targetQueueOverrides, unknownBudget,
            observerCapacity);
    }

    public ConcurrencyLimits withTargetConcurrency(Capacity capacity) {
        return new ConcurrencyLimits(globalConcurrency, capacity, targetConcurrencyOverrides, queueCapacity, targetQueueCapacity, targetQueueOverrides, unknownBudget,
            observerCapacity);
    }

    /** The limits with an own concurrency for one target. */
    public ConcurrencyLimits withTargetConcurrency(TargetId target, Capacity capacity) {
        Map<TargetId, Capacity> overrides = new HashMap<>(targetConcurrencyOverrides);
        overrides.put(Objects.requireNonNull(target, "target"), Objects.requireNonNull(capacity, "capacity"));
        return new ConcurrencyLimits(globalConcurrency, targetConcurrency, overrides, queueCapacity, targetQueueCapacity, targetQueueOverrides, unknownBudget,
            observerCapacity);
    }

    /** The limits with an own queue capacity for one target. */
    public ConcurrencyLimits withTargetQueueCapacity(TargetId target, Capacity capacity) {
        Map<TargetId, Capacity> overrides = new HashMap<>(targetQueueOverrides);
        overrides.put(Objects.requireNonNull(target, "target"), Objects.requireNonNull(capacity, "capacity"));
        return new ConcurrencyLimits(globalConcurrency, targetConcurrency, targetConcurrencyOverrides, queueCapacity, targetQueueCapacity, overrides, unknownBudget,
            observerCapacity);
    }

    /** The limits with an explicit budget for unknown operations; it no longer follows the global concurrency. */
    public ConcurrencyLimits withUnknownBudget(Capacity capacity) {
        return new ConcurrencyLimits(globalConcurrency, targetConcurrency, targetConcurrencyOverrides, queueCapacity, targetQueueCapacity, targetQueueOverrides,
            new UnknownBudget.Explicit(capacity), observerCapacity);
    }

    /** How the budget for unknown operations is set: explicitly, or following the global concurrency. */
    public sealed interface UnknownBudget permits UnknownBudget.FollowsGlobal, UnknownBudget.Explicit {

        /** The budget is the larger of 32 and the global concurrency. */
        record FollowsGlobal() implements UnknownBudget {
        }

        /** The budget is set and stays when the global concurrency changes. */
        record Explicit(Capacity capacity) implements UnknownBudget {

            public Explicit {
                Objects.requireNonNull(capacity, "capacity");
            }
        }
    }
}
