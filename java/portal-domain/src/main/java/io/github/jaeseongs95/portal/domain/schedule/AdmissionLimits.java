package io.github.jaeseongs95.portal.domain.schedule;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import java.time.Duration;
import java.util.Objects;

/**
 * The limits of the request entrance, the first of the three layers (2.x request-admission.mjs:19): how many requests are served at once, how many wait for a
 * place, how long one waits, and how many long-running requests may be detached from the entrance. The entrance itself (the semaphore and the queue) is a bean of the
 * application layer; this is the validated numbers it is built from.
 *
 * @param maxActive requests served at once, at least 1
 * @param maxQueued requests waiting for a place, 0 or more
 * @param maxWait how long a request waits for a place, from 1 millisecond to the largest timer value (2^31 - 1 ms)
 * @param maxDetached requests that may be detached from the entrance while they run, 0 or more
 */
public record AdmissionLimits(Capacity maxActive, int maxQueued, Duration maxWait, int maxDetached) {

    public static final int DEFAULT_MAX_ACTIVE = 8;
    public static final int DEFAULT_MAX_QUEUED = 32;
    public static final Duration DEFAULT_MAX_WAIT = Duration.ofMillis(5000);
    public static final int DEFAULT_MAX_DETACHED = 64;

    private static final Duration LONGEST_WAIT = Duration.ofMillis(Integer.MAX_VALUE);

    public AdmissionLimits {
        Objects.requireNonNull(maxActive, "maxActive");
        Objects.requireNonNull(maxWait, "maxWait");
        if (maxQueued < 0 || maxDetached < 0) {
            throw new IllegalArgumentException("Invalid request admission limits");
        }
        if (maxWait.compareTo(Duration.ofMillis(1)) < 0 || maxWait.compareTo(LONGEST_WAIT) > 0) {
            throw new IllegalArgumentException("Invalid request admission limits");
        }
    }

    /** The limits of a new installation: 8 at once, 32 waiting, 5 seconds of waiting, 64 detached. */
    public static AdmissionLimits defaults() {
        return new AdmissionLimits(new Capacity(DEFAULT_MAX_ACTIVE), DEFAULT_MAX_QUEUED, DEFAULT_MAX_WAIT, DEFAULT_MAX_DETACHED);
    }
}
