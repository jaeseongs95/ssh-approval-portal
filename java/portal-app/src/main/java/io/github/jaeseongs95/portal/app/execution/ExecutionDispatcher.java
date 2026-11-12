package io.github.jaeseongs95.portal.app.execution;

import java.time.Clock;
import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.task.TaskExecutor;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.event.OperationEvents;
import io.github.jaeseongs95.portal.app.history.ExecutionTimelineStore;
import io.github.jaeseongs95.portal.app.journal.ClaimResult;
import io.github.jaeseongs95.portal.app.journal.ClaimStore;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.journal.OperationQueueView;
import io.github.jaeseongs95.portal.app.operation.OperationExpiry;
import io.github.jaeseongs95.portal.app.operation.OutcomeAudit;
import io.github.jaeseongs95.portal.app.operation.OperationWrites;
import io.github.jaeseongs95.portal.app.operation.RunningExecutions;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.OperationScheduler;
import io.github.jaeseongs95.portal.domain.schedule.SchedulingDecision;

/**
 * Takes the queued operations to their runners, one claim at a time (stage 3 design 1.1 F, 3.2; cases S3-UC-01, B-186, B-196, B-358). It has no clock of its own and no
 * loop that sleeps: {@link #wake()} is called by the event that says something changed (an operation was queued, a slot was freed) and drains the queue on the injected
 * {@link TaskExecutor}.
 *
 * <p>The domain decides every step: {@link OperationScheduler#select} says expire, claim, wait or idle; the claim store claims in one transaction under the limits;
 * {@code Operation.settle} turns the executor's outcome into a state. This class reads, asks, acts and announces.
 *
 * <p><b>An operation is never run twice.</b> There is no retry anywhere: a claim that fails is decided again from the store, an execution that fails is settled as it
 * ended (or unknown), and a result that cannot be stored leaves the operation to the recovery after a restart, which settles it unknown and never sends it again.
 */
@Component
public class ExecutionDispatcher {

    private static final Logger LOG = LoggerFactory.getLogger(ExecutionDispatcher.class);
    /** The most claims, expiries and refusals one drain makes before it looks at the request flag again, so a store that keeps answering "contended" cannot spin forever. */
    private static final int MAX_STEPS = 1000;
    private static final int SETTLE_ATTEMPTS = 3;

    private final OperationJournal journal;
    private final OperationQueueView queueView;
    private final ClaimStore claims;
    private final OperationScheduler scheduler;
    private final ConcurrencyLimits limits;
    private final OperationExpiry expiry;
    private final OperationWrites writes;
    private final OutcomeAudit outcomes;
    private final OperationEvents events;
    private final RunningExecutions running;
    private final DispatchChecks checks;
    private final ExecutionTimelineStore timelines;
    private final TaskExecutor executor;
    private final Clock clock;
    private final Map<OperationKind, OperationRunner> runners = new EnumMap<>(OperationKind.class);
    private final AtomicBoolean draining = new AtomicBoolean();
    private final AtomicBoolean requested = new AtomicBoolean();
    private final AtomicBoolean open = new AtomicBoolean();

    public ExecutionDispatcher(OperationJournal journal, OperationQueueView queueView, ClaimStore claims, OperationScheduler scheduler, ConcurrencyLimits limits,
                               OperationExpiry expiry, OperationWrites writes, OutcomeAudit outcomes, OperationEvents events, RunningExecutions running,
                               DispatchChecks checks, ExecutionTimelineStore timelines, TaskExecutor executor, Clock clock, List<OperationRunner> operationRunners) {
        this.journal = journal;
        this.queueView = queueView;
        this.claims = claims;
        this.scheduler = scheduler;
        this.limits = limits;
        this.expiry = expiry;
        this.writes = writes;
        this.outcomes = outcomes;
        this.events = events;
        this.running = running;
        this.checks = checks;
        this.timelines = timelines;
        this.executor = executor;
        this.clock = clock;
        for (OperationRunner runner : operationRunners) {
            OperationRunner earlier = runners.put(runner.kind(), runner);
            if (earlier != null) {
                throw new IllegalStateException("Two OperationRunner beans run " + runner.kind() + ": " + earlier.getClass().getName() + " and " + runner.getClass().getName());
            }
        }
    }

    /**
     * Lets the dispatcher work. It is closed from the start of the application until the recovery of the journal has finished ({@code StartupRecovery}), so the first
     * claim never sees an operation that the last run left in flight. A wake that came while it was closed is not lost: opening drains the queue.
     */
    public void open() {
        if (open.compareAndSet(false, true)) {
            wake();
        }
    }

    /** Asks for a drain of the queue. Calls that come while one runs are folded into one more round; while the dispatcher is closed they only note the request. */
    public void wake() {
        requested.set(true);
        if (open.get() && draining.compareAndSet(false, true)) {
            executor.execute(this::drain);
        }
    }

    private void drain() {
        try {
            while (requested.getAndSet(false)) {
                int steps = 0;
                while (steps++ < MAX_STEPS && step()) {
                    // each step that made progress asks the store again
                }
            }
        } catch (RuntimeException e) {
            LOG.error("The dispatcher stopped this round; the next change of the queue wakes it again", e);
        } finally {
            draining.set(false);
            if (requested.get() && draining.compareAndSet(false, true)) {
                executor.execute(this::drain);
            }
        }
    }

    /** One decision of the scheduler and its action. True when something changed, so that the queue is asked again. */
    boolean step() {
        Instant now = clock.instant();
        SchedulingDecision decision = scheduler.select(queueView.schedulingView(limits, now, limits.queueCapacity().value()));
        return switch (decision) {
            case SchedulingDecision.Claim claim -> claim(claim, now);
            case SchedulingDecision.ExpireQueued expire -> expireAll(expire);
            case SchedulingDecision.Idle idle -> false;
            case SchedulingDecision.Saturated saturated -> false;
        };
    }

    private boolean expireAll(SchedulingDecision.ExpireQueued expire) {
        int expired = 0;
        for (OperationId id : expire.ids()) {
            if (expiry.expireIfDue(id)) {
                expired++;
            }
        }
        return expired > 0;
    }

    private boolean claim(SchedulingDecision.Claim claim, Instant now) {
        return switch (claims.claim(claim.id(), claim.expectedVersion(), limits, now)) {
            case ClaimResult.Claimed claimed -> {
                start(claimed.operation());
                yield true;
            }
            case ClaimResult.NotQueued notQueued -> true;
            case ClaimResult.Contended contended -> true;
            case ClaimResult.Saturated saturated -> false;
        };
    }

    private void start(Operation claimed) {
        OperationId id = claimed.id();
        CancelSource cancel = running.register(id);
        events.changed(claimed);
        try {
            executor.execute(() -> execute(claimed, cancel));
        } catch (RuntimeException e) {
            LOG.error("An execution could not be handed to the executor; the operation is refused before dispatch", e);
            running.release(id);
            refuseOrCancel(id, DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.UNKNOWN));
        }
    }

    private void execute(Operation claimed, CancelSource cancel) {
        OperationId id = claimed.id();
        try {
            run(claimed, cancel);
        } catch (RuntimeException e) {
            LOG.error("An execution ended with an error that no result describes; the recovery after a restart settles the operation", e);
        } finally {
            running.release(id);
            wake();
        }
    }

    private void run(Operation claimed, CancelSource cancel) {
        OperationId id = claimed.id();
        OperationRunner runner = runners.get(claimed.kind());
        if (runner == null) {
            refuseOrCancel(id, DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.UNKNOWN));
            return;
        }
        ExecutionReport report;
        try {
            report = runner.run(claimed, new ExecutionControl(cancel, () -> checks.beforeDispatch(id)));
        } catch (DispatchRefusedException refused) {
            refuseOrCancel(id, refused.failure());
            return;
        } catch (RuntimeException unexpected) {
            LOG.error("A runner failed after the operation may have started; the operation is settled as unknown and is not sent again", unexpected);
            report = new ExecutionReport(ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of()), ExecutionTimeline.empty());
        }
        settle(id, report);
    }

    /**
     * Stops an operation that no runner took across: a cancel that came first settles as cancelled (nothing ran), any other refusal as failed before dispatch with the
     * reason and the step. An operation that already ended is left alone.
     */
    private void refuseOrCancel(OperationId id, DispatchFailure failure) {
        for (int attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
            Optional<Operation> found = journal.find(id);
            if (found.isEmpty()) {
                return;
            }
            Operation current = found.orElseThrow();
            Instant now = clock.instant();
            Optional<Operation> next = switch (current.state()) {
                case TERMINATING -> Optional.of(current.settle(ExecutionOutcome.notDispatched(ExecutionReason.CANCEL, List.of()), now));
                case PENDING, QUEUED, STARTING -> Optional.of(current.refuseBeforeDispatch(failure, now));
                case ACCEPTED, EVALUATING, RUNNING, COMPLETED, FAILED, CANCELLED, DENIED, EXPIRED, UNKNOWN -> Optional.empty();
            };
            if (next.isEmpty()) {
                return;
            }
            try {
                outcomes.recordOutcome(writes.store(next.orElseThrow(), current.version()));
                return;
            } catch (RequestRefusedException e) {
                if (e.code() != OperationErrorCode.OPERATION_VERSION_CONFLICT) {
                    throw e;
                }
            }
        }
    }

    /**
     * Settles the operation from the executor's outcome and stores its timeline. A conflicting write (a cancel that came in between) is read again and decided again, the
     * outcome being the same; a result that cannot be stored is {@code OPERATION_OUTCOME_PERSISTENCE_FAILED} and leaves the operation to the recovery (decision on
     * S3-SF-05 c).
     */
    private void settle(OperationId id, ExecutionReport report) {
        for (int attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
            Optional<Operation> found = journal.find(id);
            if (found.isEmpty()) {
                return;
            }
            Operation current = found.orElseThrow();
            if (!current.state().isActive()) {
                LOG.warn("An operation was settled by something else while it ran; its outcome is not stored again");
                return;
            }
            Operation settled = current.settle(report.outcome(), clock.instant());
            Operation stored;
            try {
                stored = writes.store(settled, current.version());
            } catch (RequestRefusedException e) {
                if (e.code() == OperationErrorCode.OPERATION_VERSION_CONFLICT) {
                    continue;
                }
                throw new RequestRefusedException(OperationErrorCode.OPERATION_OUTCOME_PERSISTENCE_FAILED, e);
            } catch (RuntimeException e) {
                throw new RequestRefusedException(OperationErrorCode.OPERATION_OUTCOME_PERSISTENCE_FAILED, e);
            }
            recordTimeline(id, report.timeline());
            outcomes.recordOutcome(stored);
            return;
        }
        throw new RequestRefusedException(OperationErrorCode.OPERATION_OUTCOME_PERSISTENCE_FAILED);
    }

    private void recordTimeline(OperationId id, ExecutionTimeline timeline) {
        try {
            timelines.record(id, timeline);
        } catch (RuntimeException e) {
            LOG.error("The timeline of an execution could not be stored; the result of the operation is unchanged", e);
        }
    }
}
