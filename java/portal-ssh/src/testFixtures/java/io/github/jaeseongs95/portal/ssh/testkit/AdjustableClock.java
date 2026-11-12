package io.github.jaeseongs95.portal.ssh.testkit;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The system clock plus an offset that a test moves forward: a test that needs "the session has been idle for a minute" calls {@link #advance(Duration)} instead of waiting
 * (no sleep, and no dependence on how many microseconds passed between two calls).
 */
public final class AdjustableClock extends Clock {

    private final AtomicReference<Duration> offset = new AtomicReference<>(Duration.ZERO);

    /** Moves the clock forward. */
    public void advance(Duration by) {
        offset.updateAndGet(current -> current.plus(by));
    }

    @Override
    public ZoneId getZone() {
        return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return this;
    }

    @Override
    public Instant instant() {
        return Clock.systemUTC().instant().plus(offset.get());
    }
}
