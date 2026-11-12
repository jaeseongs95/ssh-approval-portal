package io.github.jaeseongs95.portal.app.operation;

import java.time.Duration;

import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.Operation;

/**
 * Arms the timer that expires a waiting operation at its deadline, so a waiter is woken without a reaper that polls (2.x approval-queue, cases A-146, A-147). The timer
 * only asks {@link OperationExpiry}, which reads the operation again, so a timer that fires after the operation moved on does nothing.
 */
@Component
public class ExpiryTimers {

    private static final Duration TIMER_MARGIN = Duration.ofMillis(10);

    private final TaskScheduler scheduler;
    private final OperationExpiry expiry;

    public ExpiryTimers(TaskScheduler scheduler, OperationExpiry expiry) {
        this.scheduler = scheduler;
        this.expiry = expiry;
    }

    /** Arms the timer of an operation that still waits and has a deadline; any other operation is ignored. */
    public void arm(Operation operation) {
        if (operation.state().isPreDispatch() && operation.expiry() instanceof Deadline.At at) {
            // The margin keeps the timer from firing before the deadline by the difference of the scheduler's clock and the application's: an operation that is not yet late is
            // left alone by OperationExpiry, and nothing would arm the timer again.
            scheduler.schedule(() -> expiry.expireIfDue(operation.id()), at.instant().plus(TIMER_MARGIN));
        }
    }
}
