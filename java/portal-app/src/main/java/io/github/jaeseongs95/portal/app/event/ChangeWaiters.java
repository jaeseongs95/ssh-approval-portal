package io.github.jaeseongs95.portal.app.event;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;

import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;

/**
 * Who waits for an operation to change (2.x {@code scheduler.observe}, cases A-142 to A-155, B-193 to B-196). A waiter is woken by {@link OperationChanged} and by its
 * own deadline, both from the infrastructure, so no thread sleeps or polls. An abort of the waiter ends the wait and nothing else: the operation is never cancelled
 * by a caller that stops waiting (B-193). The number of waiters is bounded by the observer capacity ({@code OPERATION_OBSERVER_CAPACITY}, A-148).
 */
@Component
public class ChangeWaiters {

    private final TaskScheduler scheduler;
    private final ConcurrencyLimits limits;
    private final Clock clock;
    private final Object lock = new Object();
    private final Map<OperationId, List<Waiter>> byOperation = new HashMap<>();
    private int waiting;

    public ChangeWaiters(TaskScheduler scheduler, ConcurrencyLimits limits, Clock clock) {
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.limits = Objects.requireNonNull(limits, "limits");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Waits until the operation has a version above {@code afterVersion}, or until {@code timeout} has passed. The future fails with
     * {@code RequestRefusedException(OPERATION_OBSERVER_ABORTED)} when the cancel token is asked to stop; the wait is then gone and the operation is untouched. A caller
     * that registers and then reads the operation again does not miss a change that happened between the two.
     *
     * @throws RequestRefusedException {@code OPERATION_OBSERVER_CAPACITY} when as many waiters as the observer capacity are already waiting
     */
    public CompletableFuture<WaitResult> await(OperationId id, long afterVersion, Duration timeout, CancelToken cancel) {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(timeout, "timeout");
        Objects.requireNonNull(cancel, "cancel");
        CompletableFuture<WaitResult> result = new CompletableFuture<>();
        Waiter waiter = new Waiter(id, afterVersion, result);
        synchronized (lock) {
            if (waiting >= limits.observerCapacity().value()) {
                throw new RequestRefusedException(OperationErrorCode.OPERATION_OBSERVER_CAPACITY);
            }
            byOperation.computeIfAbsent(id, key -> new ArrayList<>()).add(waiter);
            waiting++;
        }
        result.whenComplete((value, failure) -> forget(waiter));
        waiter.timer = scheduler.schedule(() -> result.complete(new WaitResult.TimedOut()), clock.instant().plus(timeout));
        cancel.whenRequested().thenRun(() -> result.completeExceptionally(new RequestRefusedException(OperationErrorCode.OPERATION_OBSERVER_ABORTED)));
        return result;
    }

    /** The number of waiters now. */
    public int waiting() {
        synchronized (lock) {
            return waiting;
        }
    }

    /** Wakes the waiters of the operation that saw an older version. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void changed(OperationChanged event) {
        List<Waiter> due = new ArrayList<>();
        synchronized (lock) {
            for (Waiter waiter : byOperation.getOrDefault(event.id(), List.of())) {
                if (waiter.afterVersion < event.version()) {
                    due.add(waiter);
                }
            }
        }
        for (Waiter waiter : due) {
            waiter.result.complete(new WaitResult.Changed(event.version()));
        }
    }

    private void forget(Waiter waiter) {
        synchronized (lock) {
            List<Waiter> list = byOperation.get(waiter.id);
            if (list != null && list.remove(waiter)) {
                waiting--;
                if (list.isEmpty()) {
                    byOperation.remove(waiter.id);
                }
            }
        }
        ScheduledFuture<?> timer = waiter.timer;
        if (timer != null) {
            timer.cancel(false);
        }
    }

    private static final class Waiter {

        private final OperationId id;
        private final long afterVersion;
        private final CompletableFuture<WaitResult> result;
        private volatile ScheduledFuture<?> timer;

        private Waiter(OperationId id, long afterVersion, CompletableFuture<WaitResult> result) {
            this.id = id;
            this.afterVersion = afterVersion;
            this.result = result;
        }
    }
}
