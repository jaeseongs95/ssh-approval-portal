package io.github.jaeseongs95.portal.app.remote;

import java.time.Duration;
import java.util.Objects;

import org.springframework.util.unit.DataSize;

/**
 * The limits one execution runs under (2.x {@code execution-supervisor.mjs:3-5, 9-11}): the time after which it is stopped, the grace the stop has before the channel
 * is closed, and how many bytes of each output stream are kept. A value below one millisecond or one byte, or above 2^31-1 of either, is refused as 2.x refused it.
 *
 * @param deadline the time limit of the execution
 * @param stopGrace how long a stop (cancel or deadline) waits for the process to end before the channel is closed
 * @param outputPerStream the bytes kept of standard output and of standard error, each
 */
public record ExecutionLimits(Duration deadline, Duration stopGrace, DataSize outputPerStream) {

    /** 2.x {@code DEFAULT_RUN_TIMEOUT_MS}. */
    public static final Duration DEFAULT_DEADLINE = Duration.ofSeconds(120);
    /** 2.x {@code DEFAULT_STOP_GRACE_MS}. */
    public static final Duration DEFAULT_STOP_GRACE = Duration.ofSeconds(5);
    /** 2.x {@code DEFAULT_OUTPUT_BYTES}. */
    public static final DataSize DEFAULT_OUTPUT_PER_STREAM = DataSize.ofMegabytes(1);

    private static final Duration ONE_MILLISECOND = Duration.ofMillis(1);
    private static final Duration LONGEST = Duration.ofMillis(Integer.MAX_VALUE);

    public ExecutionLimits {
        requireSupervisable(deadline, "deadline");
        requireSupervisable(stopGrace, "stopGrace");
        Objects.requireNonNull(outputPerStream, "outputPerStream");
        if (outputPerStream.toBytes() < 1 || outputPerStream.toBytes() > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Invalid execution outputPerStream: 1 to 2147483647 bytes");
        }
    }

    /** The limits of 2.x: 120 seconds, a grace of 5 seconds and 1 MiB per stream. */
    public static ExecutionLimits defaults() {
        return new ExecutionLimits(DEFAULT_DEADLINE, DEFAULT_STOP_GRACE, DEFAULT_OUTPUT_PER_STREAM);
    }

    /** The one rule of a supervised duration, shared with {@link TransferLimits}: 1 millisecond to 2^31-1 milliseconds. */
    static Duration requireSupervisable(Duration value, String name) {
        Objects.requireNonNull(value, name);
        if (value.compareTo(ONE_MILLISECOND) < 0 || value.compareTo(LONGEST) > 0) {
            throw new IllegalArgumentException("Invalid execution " + name + ": 1 to 2147483647 milliseconds");
        }
        return value;
    }
}
