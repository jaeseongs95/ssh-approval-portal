package io.github.jaeseongs95.portal.domain.schedule;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.REVISION;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.id;
import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.approval.AdmissionDecision;
import io.github.jaeseongs95.portal.domain.approval.CapacityKind;
import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class OperationSchedulerTest {

    private static final Instant NOW = T0.plusSeconds(100);
    private static final Deadline FAR = new Deadline.At(T0.plus(Duration.ofHours(1)));
    private final OperationScheduler scheduler = new OperationScheduler();

    @Test
    @DisplayName("S2-SC-01 the target that rested longest goes first, whatever the queue depths, and the same view always gives the same decision")
    void longestRestingTargetFirst() {
        List<QueuedOperation> queue = List.of(entry('1', "alpha", 1), entry('2', "alpha", 2), entry('3', "beta", 3), entry('4', "gamma", 4), entry('5', "alpha", 5));
        Map<TargetId, Instant> last = Map.of(new TargetId("alpha"), T0.plusSeconds(30), new TargetId("beta"), T0.plusSeconds(10), new TargetId("gamma"), T0.plusSeconds(20));
        SchedulingView view = view(queue, 0, Map.of(), 0, last, Set.of(), ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(5)));
        SchedulingDecision first = scheduler.select(view);
        assertThat(first).isEqualTo(new SchedulingDecision.Claim(id('3'), 1));
        assertThat(new OperationScheduler().select(view)).as("another instance, the same view").isEqualTo(first);
        assertThat(scheduler.select(view)).isEqualTo(first);
        Map<TargetId, Instant> reversed = Map.of(new TargetId("alpha"), T0.plusSeconds(10), new TargetId("beta"), T0.plusSeconds(30), new TargetId("gamma"), T0.plusSeconds(20));
        assertThat(scheduler.select(view(queue, 0, Map.of(), 0, reversed, Set.of(), ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(5)))))
            .as("inside a target the order is first come first served").isEqualTo(new SchedulingDecision.Claim(id('1'), 1));
    }

    @Test
    @DisplayName("RC-B-186 targets that never started go first by their place in line; the order of starts is a1 b1 c1 a2 b2 a3, one at a time")
    void targetRingFairness() {
        List<QueuedOperation> remaining = new ArrayList<>(List.of(entry('a', "alpha", 1), entry('b', "alpha", 2), entry('c', "alpha", 3), entry('d', "beta", 4), entry('e', "beta", 5),
            entry('f', "gamma", 6)));
        Map<OperationId, String> names = Map.of(id('a'), "a1", id('b'), "a2", id('c'), "a3", id('d'), "b1", id('e'), "b2", id('f'), "c1");
        Map<TargetId, Instant> last = new HashMap<>();
        List<String> started = new ArrayList<>();
        ConcurrencyLimits oneAtATime = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(1));
        for (int step = 0; step < 6; step++) {
            SchedulingDecision decision = scheduler.select(view(remaining, 0, Map.of(), 0, last, Set.of(), oneAtATime));
            assertThat(decision).isInstanceOf(SchedulingDecision.Claim.class);
            OperationId claimed = ((SchedulingDecision.Claim) decision).id();
            QueuedOperation entry = remaining.stream().filter(candidate -> candidate.id().equals(claimed)).findFirst().orElseThrow();
            started.add(names.get(claimed));
            last.put(entry.targetId(), T0.plusSeconds(step));
            remaining.remove(entry);
        }
        assertThat(started).containsExactly("a1", "b1", "c1", "a2", "b2", "a3");
        assertThat(scheduler.select(view(remaining, 0, Map.of(), 0, last, Set.of(), oneAtATime))).isEqualTo(new SchedulingDecision.Idle());
    }

    @Test
    @DisplayName("S2-SC-02 each limit has its own reason: global concurrency, target concurrency, unknown budget, conflict fence; an empty queue is idle")
    void saturationReasons() {
        List<QueuedOperation> queue = List.of(entry('1', "alpha", 1));
        ConcurrencyLimits defaults = ConcurrencyLimits.defaults();
        assertThat(scheduler.select(view(List.of(), 0, Map.of(), 0, Map.of(), Set.of(), defaults))).isEqualTo(new SchedulingDecision.Idle());
        assertThat(scheduler.select(view(queue, 2, Map.of(new TargetId("beta"), 2), 0, Map.of(), Set.of(), defaults))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
        assertThat(scheduler.select(view(queue, 1, Map.of(new TargetId("alpha"), 1), 0, Map.of(), Set.of(), defaults))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.TARGET_CONCURRENCY));
        ConcurrencyLimits tight = defaults.withGlobalConcurrency(new Capacity(5)).withUnknownBudget(new Capacity(2));
        assertThat(scheduler.select(view(queue, 0, Map.of(), 2, Map.of(), Set.of(), tight))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.UNKNOWN_BUDGET));
        assertThat(scheduler.select(view(queue, 1, Map.of(new TargetId("beta"), 1), 0, Map.of(), Set.of(), tight))).as("running plus unknown below the budget").isInstanceOf(SchedulingDecision.Claim.class);
        QueuedOperation fencedEntry = new QueuedOperation(id('1'), 1, new TargetId("alpha"), REVISION, new ConflictKey.Of("install"), FAR, 1);
        Set<FenceKey> fence = Set.of(new FenceKey(new TargetId("alpha"), REVISION, "install"));
        assertThat(scheduler.select(view(List.of(fencedEntry), 0, Map.of(), 0, Map.of(), fence, defaults))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.CONFLICT_FENCE));
    }

    @Test
    @DisplayName("S2-SC-02 operations whose deadline has passed are expired before anything is claimed")
    void expiredBeforeClaim() {
        QueuedOperation late = new QueuedOperation(id('1'), 1, new TargetId("alpha"), REVISION, new ConflictKey.None(), new Deadline.At(NOW), 1);
        QueuedOperation fine = entry('2', "beta", 2);
        assertThat(scheduler.select(view(List.of(late, fine), 0, Map.of(), 0, Map.of(), Set.of(), ConcurrencyLimits.defaults())))
            .isEqualTo(new SchedulingDecision.ExpireQueued(List.of(id('1'))));
        QueuedOperation early = new QueuedOperation(id('1'), 1, new TargetId("alpha"), REVISION, new ConflictKey.None(), new Deadline.At(NOW.plusNanos(1)), 1);
        assertThat(scheduler.select(view(List.of(early), 0, Map.of(), 0, Map.of(), Set.of(), ConcurrencyLimits.defaults()))).isInstanceOf(SchedulingDecision.Claim.class);
    }

    @Test
    @DisplayName("RC-B-188 a fenced resource blocks only its own operations: the next operation of the same target starts, another revision is not fenced")
    void unknownFencesOneConflictKey() {
        QueuedOperation fenced = new QueuedOperation(id('1'), 1, new TargetId("alpha"), REVISION, new ConflictKey.Of("install"), FAR, 1);
        QueuedOperation independent = new QueuedOperation(id('2'), 1, new TargetId("alpha"), REVISION, new ConflictKey.None(), FAR, 2);
        Set<FenceKey> fence = Set.of(new FenceKey(new TargetId("alpha"), REVISION, "install"));
        ConcurrencyLimits limits = ConcurrencyLimits.defaults();
        assertThat(scheduler.select(view(List.of(fenced, independent), 0, Map.of(), 0, Map.of(), fence, limits))).isEqualTo(new SchedulingDecision.Claim(id('2'), 1));
        QueuedOperation otherRevision = new QueuedOperation(id('3'), 1, new TargetId("alpha"), TargetRevision.of("b".repeat(64)), new ConflictKey.Of("install"), FAR, 1);
        assertThat(scheduler.select(view(List.of(otherRevision), 0, Map.of(), 0, Map.of(), fence, limits))).isEqualTo(new SchedulingDecision.Claim(id('3'), 1));
        QueuedOperation otherKey = new QueuedOperation(id('4'), 1, new TargetId("alpha"), REVISION, new ConflictKey.Of("independent"), FAR, 1);
        assertThat(scheduler.select(view(List.of(otherKey), 0, Map.of(), 0, Map.of(), fence, limits))).isEqualTo(new SchedulingDecision.Claim(id('4'), 1));
    }

    @Test
    @DisplayName("RC-A-745 RC-A-746 the limits are checked values; at the limit nothing is claimed, below it one is, and a released slot is claimable again")
    void claimLimitsAndRelease() {
        ConcurrencyLimits two = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(2)).withTargetConcurrency(new Capacity(2));
        List<QueuedOperation> queue = List.of(entry('1', "alpha", 1), entry('2', "alpha", 2), entry('3', "alpha", 3));
        assertThat(scheduler.select(view(queue, 0, Map.of(), 0, Map.of(), Set.of(), two))).isInstanceOf(SchedulingDecision.Claim.class);
        assertThat(scheduler.select(view(queue, 1, Map.of(new TargetId("alpha"), 1), 0, Map.of(), Set.of(), two))).isInstanceOf(SchedulingDecision.Claim.class);
        assertThat(scheduler.select(view(queue, 2, Map.of(new TargetId("alpha"), 2), 0, Map.of(), Set.of(), two)))
            .as("RC-A-766 two run at once, the third waits").isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
        assertThat(scheduler.select(view(queue, 1, Map.of(new TargetId("alpha"), 1), 0, Map.of(), Set.of(), two))).as("a released slot is claimable again")
            .isInstanceOf(SchedulingDecision.Claim.class);
        ConcurrencyLimits onePerTarget = ConcurrencyLimits.defaults();
        assertThat(onePerTarget.concurrencyOf(new TargetId("alpha"))).isEqualTo(new Capacity(1));
        assertThat(onePerTarget.withTargetConcurrency(new TargetId("alpha"), new Capacity(3)).concurrencyOf(new TargetId("alpha"))).isEqualTo(new Capacity(3));
        assertThat(onePerTarget.withTargetConcurrency(new TargetId("alpha"), new Capacity(3)).concurrencyOf(new TargetId("beta"))).isEqualTo(new Capacity(1));
    }

    @Test
    @DisplayName("RC-A-767 RC-B-065 a read waits in the same queue behind a running operation; a target runs one at a time while another target proceeds, never more than the global limit")
    void waitingAndSerialization() {
        ConcurrencyLimits one = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(1));
        List<QueuedOperation> queue = List.of(entry('1', "alpha", 1));
        assertThat(scheduler.select(view(queue, 1, Map.of(new TargetId("alpha"), 1), 0, Map.of(), Set.of(), one))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
        assertThat(scheduler.select(view(queue, 0, Map.of(), 0, Map.of(), Set.of(), one))).isEqualTo(new SchedulingDecision.Claim(id('1'), 1));
        List<QueuedOperation> mixed = List.of(entry('2', "alpha", 1), entry('3', "beta", 2));
        ConcurrencyLimits two = ConcurrencyLimits.defaults();
        assertThat(scheduler.select(view(mixed, 1, Map.of(new TargetId("alpha"), 1), 0, Map.of(), Set.of(), two))).as("alpha is busy, beta proceeds").isEqualTo(new SchedulingDecision.Claim(id('3'), 1));
        assertThat(scheduler.select(view(mixed, 2, Map.of(new TargetId("alpha"), 1, new TargetId("beta"), 1), 0, Map.of(), Set.of(), two))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
    }

    @Test
    @DisplayName("RC-A-747 RC-B-192 S2-SC-03 the queue admits up to its capacity in total and per target, and refuses the next with OPERATION_QUEUE_FULL")
    void queueAdmission() {
        ConcurrencyLimits defaults = ConcurrencyLimits.defaults();
        assertThat(defaults.queueCapacity()).as("default 32").isEqualTo(new Capacity(32));
        assertThat(defaults.targetQueueCapacity()).isEqualTo(new Capacity(32));
        TargetId alpha = new TargetId("alpha");
        assertThat(scheduler.admitToQueue(alpha, view(waiting("alpha", 31), 0, Map.of(), 0, Map.of(), Set.of(), defaults))).isEqualTo(new AdmissionDecision.Admit());
        AdmissionDecision full = scheduler.admitToQueue(alpha, view(waiting("alpha", 32), 0, Map.of(), 0, Map.of(), Set.of(), defaults));
        assertThat(full).isEqualTo(new AdmissionDecision.RejectedCapacity(CapacityKind.EXECUTION_QUEUE));
        ConcurrencyLimits roomy = defaults.withQueueCapacity(new Capacity(100)).withTargetQueueCapacity(alpha, new Capacity(2));
        assertThat(scheduler.admitToQueue(alpha, view(waiting("alpha", 2), 0, Map.of(), 0, Map.of(), Set.of(), roomy))).isEqualTo(new AdmissionDecision.RejectedCapacity(CapacityKind.TARGET_QUEUE));
        assertThat(scheduler.admitToQueue(new TargetId("beta"), view(waiting("alpha", 2), 0, Map.of(), 0, Map.of(), Set.of(), roomy))).isEqualTo(new AdmissionDecision.Admit());
        ConcurrencyLimits shrunk = defaults.withGlobalConcurrency(new Capacity(1)).withTargetConcurrency(new Capacity(1)).withQueueCapacity(new Capacity(1));
        assertThat(scheduler.admitToQueue(alpha, view(waiting("alpha", 2), 2, Map.of(alpha, 2), 0, Map.of(), Set.of(), shrunk))).as("RC-B-192 a reduced capacity refuses new work")
            .isEqualTo(new AdmissionDecision.RejectedCapacity(CapacityKind.EXECUTION_QUEUE));
        assertThat(scheduler.select(view(waiting("alpha", 2), 2, Map.of(alpha, 2), 0, Map.of(), Set.of(), shrunk))).as("the running ones are kept and nothing new starts")
            .isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
        assertThat(scheduler.select(view(waiting("alpha", 2), 1, Map.of(alpha, 1), 0, Map.of(), Set.of(), shrunk))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.GLOBAL_CONCURRENCY));
        assertThat(scheduler.select(view(waiting("alpha", 2), 0, Map.of(), 0, Map.of(), Set.of(), shrunk))).isInstanceOf(SchedulingDecision.Claim.class);
    }

    @Test
    @DisplayName("RC-B-190 S2-SC-03 operations of unknown result that wait for the owner use a shared budget; a new one is refused with OPERATION_RECONCILIATION_CAPACITY")
    void unknownBudgetIsShared() {
        ConcurrencyLimits budget = ConcurrencyLimits.defaults().withUnknownBudget(new Capacity(2));
        TargetId alpha = new TargetId("alpha");
        assertThat(scheduler.admitToQueue(alpha, view(List.of(), 0, Map.of(), 2, Map.of(), Set.of(), budget))).isEqualTo(new AdmissionDecision.RejectedCapacity(CapacityKind.RECONCILIATION));
        assertThat(scheduler.admitToQueue(alpha, view(List.of(), 0, Map.of(), 1, Map.of(), Set.of(), budget))).isEqualTo(new AdmissionDecision.Admit());
        assertThat(scheduler.select(view(List.of(entry('1', "alpha", 1)), 0, Map.of(), 2, Map.of(), Set.of(), budget))).isEqualTo(new SchedulingDecision.Saturated(SaturationReason.UNKNOWN_BUDGET));
        assertThat(scheduler.select(view(List.of(entry('1', "alpha", 1)), 1, Map.of(new TargetId("beta"), 1), 1, Map.of(), Set.of(), budget.withGlobalConcurrency(new Capacity(3)))))
            .as("one running and one unknown fill a budget of two").isEqualTo(new SchedulingDecision.Saturated(SaturationReason.UNKNOWN_BUDGET));
    }

    @Test
    @DisplayName("RC-B-198 there is no arbitrary upper bound, and the unknown budget follows the global concurrency unless it was set")
    void noArbitraryBounds() {
        ConcurrencyLimits big = ConcurrencyLimits.defaults().withGlobalConcurrency(new Capacity(10001));
        assertThat(big.globalConcurrency()).isEqualTo(new Capacity(10001));
        assertThat(big.unknownBudgetLimit()).isEqualTo(new Capacity(10001));
        assertThat(big.withGlobalConcurrency(new Capacity(20001)).withQueueCapacity(new Capacity(50001)).unknownBudgetLimit()).isEqualTo(new Capacity(20001));
        assertThat(ConcurrencyLimits.defaults().unknownBudgetLimit()).as("at least 32").isEqualTo(new Capacity(32));
        ConcurrencyLimits explicit = ConcurrencyLimits.defaults().withUnknownBudget(new Capacity(4)).withGlobalConcurrency(new Capacity(30001));
        assertThat(explicit.unknownBudgetLimit()).isEqualTo(new Capacity(4));
        assertThat(ConcurrencyLimits.defaults()).isEqualTo(new ConcurrencyLimits(new Capacity(2), new Capacity(1), Map.of(), new Capacity(32), new Capacity(32), Map.of(),
            new ConcurrencyLimits.UnknownBudget.FollowsGlobal(), new Capacity(256)));
    }

    private static QueuedOperation entry(char digit, String target, long sequence) {
        return new QueuedOperation(id(digit), 1, new TargetId(target), REVISION, new ConflictKey.None(), FAR, sequence);
    }

    private static List<QueuedOperation> waiting(String target, int count) {
        List<QueuedOperation> queue = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            queue.add(new QueuedOperation(new OperationId(String.format("%048x", i + 1)), 1, new TargetId(target), REVISION, new ConflictKey.None(), FAR, i + 1));
        }
        return queue;
    }

    private static SchedulingView view(List<QueuedOperation> queued, int activeTotal, Map<TargetId, Integer> activeByTarget, int liveUnknown, Map<TargetId, Instant> lastStartedAt,
                                       Set<FenceKey> fenced, ConcurrencyLimits limits) {
        return new SchedulingView(queued, activeTotal, activeByTarget, liveUnknown, lastStartedAt, fenced, limits, NOW);
    }
}
