package io.github.jaeseongs95.portal.app.admission;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledFuture;

import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.schedule.AdmissionLimits;

/**
 * The entrance of the requests, the first of the three layers (2.x {@code request-admission.mjs}, cases B-372 to B-378): at most {@code maxActive} requests hold a place,
 * at most {@code maxQueued} wait for one in the order they came, a waiter gives up after {@code maxWait}, and at most {@code maxDetached} requests run on after they
 * gave their place back. A request that is granted a place keeps it even if it is cancelled at that moment; it gives the place back by {@link AdmissionTicket#release}.
 * Time comes from the injected clock and the timers from the injected scheduler, so nothing sleeps.
 *
 * <p>Every refusal is a {@link RequestRefusedException} with a {@link CapacityErrorCode}: {@code REQUEST_QUEUE_FULL}, {@code REQUEST_QUEUE_TIMEOUT},
 * {@code REQUEST_ABORTED}, {@code REQUEST_QUEUE_CLOSED}, {@code REQUEST_WAIT_LIMIT}.
 */
@Component
public class RequestAdmission {

    private final AdmissionLimits limits;
    private final TaskScheduler scheduler;
    private final Clock clock;
    private final Object lock = new Object();
    private final ArrayDeque<Waiter> queue = new ArrayDeque<>();
    private int active;
    private int detached;
    private boolean closed;

    public RequestAdmission(AdmissionLimits limits, TaskScheduler scheduler, Clock clock) {
        this.limits = Objects.requireNonNull(limits, "limits");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * Asks for a place. The stage completes with the ticket when the request holds a place, or fails with the refusal.
     * A request that comes while others wait does not pass them.
     */
    public CompletionStage<AdmissionTicket> acquire(CancelToken cancel) {
        Objects.requireNonNull(cancel, "cancel");
        Waiter waiter;
        synchronized (lock) {
            if (closed) {
                return CompletableFuture.failedStage(refusal(CapacityErrorCode.REQUEST_QUEUE_CLOSED));
            }
            if (cancel.requested()) {
                return CompletableFuture.failedStage(refusal(CapacityErrorCode.REQUEST_ABORTED));
            }
            if (active < limits.maxActive().value() && queue.isEmpty()) {
                active++;
                return CompletableFuture.completedStage(new Ticket());
            }
            if (queue.size() >= limits.maxQueued()) {
                return CompletableFuture.failedStage(refusal(CapacityErrorCode.REQUEST_QUEUE_FULL));
            }
            waiter = new Waiter(clock.instant().plus(limits.maxWait()));
            queue.addLast(waiter);
        }
        waiter.timer = scheduler.schedule(() -> leave(waiter, CapacityErrorCode.REQUEST_QUEUE_TIMEOUT), waiter.deadline);
        cancel.whenRequested().thenRun(() -> leave(waiter, CapacityErrorCode.REQUEST_ABORTED));
        return waiter.future;
    }

    public AdmissionSnapshot snapshot() {
        synchronized (lock) {
            return new AdmissionSnapshot(active, queue.size(), detached, closed);
        }
    }

    /** The entrance takes no new request and every waiter is refused with {@code REQUEST_QUEUE_CLOSED}; the places held now stay until they are released. */
    public void close() {
        List<Waiter> refused;
        synchronized (lock) {
            closed = true;
            refused = new ArrayList<>(queue);
            queue.clear();
        }
        for (Waiter waiter : refused) {
            waiter.future.completeExceptionally(refusal(CapacityErrorCode.REQUEST_QUEUE_CLOSED));
            cancelTimer(waiter);
        }
    }

    /** Takes a waiter out of the line with a refusal; a waiter that was granted a place in the meantime is no longer in the line and is left alone. */
    private void leave(Waiter waiter, ErrorCode code) {
        boolean removed;
        synchronized (lock) {
            removed = queue.remove(waiter);
        }
        if (removed) {
            waiter.future.completeExceptionally(new RequestRefusedException(code));
            cancelTimer(waiter);
        }
    }

    /** Hands the free places to the waiters in order; a waiter whose time is up is refused instead of granted. Must be called without the lock. */
    private void promote() {
        List<Waiter> granted = new ArrayList<>();
        List<Waiter> late = new ArrayList<>();
        synchronized (lock) {
            Instant now = clock.instant();
            while (!queue.isEmpty() && active < limits.maxActive().value()) {
                Waiter waiter = queue.pollFirst();
                if (now.isBefore(waiter.deadline)) {
                    active++;
                    granted.add(waiter);
                } else {
                    late.add(waiter);
                }
            }
        }
        for (Waiter waiter : granted) {
            waiter.future.complete(new Ticket());
            cancelTimer(waiter);
        }
        for (Waiter waiter : late) {
            waiter.future.completeExceptionally(refusal(CapacityErrorCode.REQUEST_QUEUE_TIMEOUT));
            cancelTimer(waiter);
        }
    }

    private static void cancelTimer(Waiter waiter) {
        ScheduledFuture<?> timer = waiter.timer;
        if (timer != null) {
            timer.cancel(false);
        }
    }

    private static RequestRefusedException refusal(ErrorCode code) {
        return new RequestRefusedException(code);
    }

    private static final class Waiter {

        private final Instant deadline;
        private final CompletableFuture<AdmissionTicket> future = new CompletableFuture<>();
        private volatile ScheduledFuture<?> timer;

        private Waiter(Instant deadline) {
            this.deadline = deadline;
        }
    }

    private final class Ticket implements AdmissionTicket {

        private boolean released;
        private boolean detachedHere;

        @Override
        public void release() {
            synchronized (lock) {
                if (released) {
                    return;
                }
                released = true;
                if (detachedHere) {
                    detached--;
                    return;
                }
                active--;
            }
            promote();
        }

        @Override
        public void detach() {
            synchronized (lock) {
                if (released || detachedHere) {
                    return;
                }
                if (closed) {
                    throw refusal(CapacityErrorCode.REQUEST_QUEUE_CLOSED);
                }
                if (detached >= limits.maxDetached()) {
                    throw refusal(CapacityErrorCode.REQUEST_WAIT_LIMIT);
                }
                detachedHere = true;
                detached++;
                active--;
            }
            promote();
        }
    }
}
