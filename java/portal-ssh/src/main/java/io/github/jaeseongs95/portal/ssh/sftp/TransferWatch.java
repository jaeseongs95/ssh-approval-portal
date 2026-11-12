package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import java.time.Clock;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.scheduling.TaskScheduler;

/**
 * Watches one file transfer for the two things that stop it from outside: the time limit and the owner's cancel. Both are events, not a poll: the deadline is a task of
 * the injected {@link TaskScheduler}, the cancel is a subscription to {@link CancelToken#whenRequested()}. When one fires, the watch records which, and runs the
 * interrupt (it closes the SFTP channel, so a call that blocks on the network fails at once). The first cause wins and stays.
 *
 * <p>The watch can be disarmed. The adapter does that when the replacement of a file begins: a few steps that must run to their end, so that an owner's cancel does not
 * leave a half-replaced file. A cancel is a request, and the result of the transfer says what became of it.
 *
 * <p>One watch serves one transfer and is closed with it. It is thread safe: the scheduler's thread and the cancelling thread call into it while the transfer thread
 * reads it.
 */
final class TransferWatch implements AutoCloseable {

    private final CancelToken cancel;
    private final AtomicReference<TransferFailureCause> fired = new AtomicReference<>();
    private final ScheduledFuture<?> deadlineTask;
    private volatile Runnable interrupt = () -> { };
    private volatile boolean armed = true;

    TransferWatch(TaskScheduler scheduler, Clock clock, Duration deadline, CancelToken cancel) {
        Objects.requireNonNull(scheduler, "scheduler");
        Objects.requireNonNull(clock, "clock");
        Objects.requireNonNull(deadline, "deadline");
        this.cancel = Objects.requireNonNull(cancel, "cancel");
        this.deadlineTask = scheduler.schedule(() -> fire(TransferFailureCause.DEADLINE), clock.instant().plus(deadline));
        cancel.whenRequested().thenRun(() -> fire(TransferFailureCause.CANCELLED));
    }

    /** What to do when the transfer is stopped from outside; runs at once when it already was. */
    void interruptWith(Runnable action) {
        this.interrupt = Objects.requireNonNull(action, "action");
        if (fired.get() != null && armed) {
            action.run();
        }
    }

    /** Why the transfer was stopped from outside, if it was. */
    Optional<TransferFailureCause> fired() {
        return Optional.ofNullable(fired.get());
    }

    /** The checkpoint of a loop: the cause when the transfer was stopped, also when the cancel was requested a moment ago and the event has not run yet. */
    Optional<TransferFailureCause> stopRequested() {
        if (armed && fired.get() == null && cancel.requested()) {
            fire(TransferFailureCause.CANCELLED);
        }
        return fired();
    }

    /** From now on nothing stops the transfer from outside. */
    void disarm() {
        armed = false;
        deadlineTask.cancel(false);
    }

    @Override
    public void close() {
        disarm();
    }

    private void fire(TransferFailureCause cause) {
        if (armed && fired.compareAndSet(null, cause)) {
            interrupt.run();
        }
    }
}
