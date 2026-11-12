package io.github.jaeseongs95.portal.store.output;

import java.time.Duration;
import java.util.Objects;

/**
 * The limits of the command-output store (2.x {@code command-output.mjs:8, 144-147}): an output is kept one hour, one output holds at most 16 MiB (the spool of raw
 * frames and the two finished renderings are each held to this size), all outputs charge at most 128 MiB, at most 1000 outputs exist, and the disk of the payload
 * folder needs the per-output limit plus 1 MiB free before a reservation is accepted. The defaults are the constants of this type; a test builds a smaller instance.
 */
public record OutputLimits(Duration ttl, long maxOutputBytes, long budgetBytes, int maxCount, long diskMarginBytes) {

    /** How long an output is kept after its reservation. */
    public static final Duration TTL = Duration.ofHours(1);
    /** The size one output may hold. */
    public static final long MAX_OUTPUT_BYTES = 16L * 1024 * 1024;
    /** The sum of the charges of all outputs. */
    public static final long BUDGET_BYTES = 128L * 1024 * 1024;
    /** The number of outputs that may exist at one time. */
    public static final int MAX_COUNT = 1000;
    /** The free space the disk must have beyond the per-output limit. */
    public static final long DISK_MARGIN_BYTES = 1024L * 1024;

    public OutputLimits {
        Objects.requireNonNull(ttl, "ttl");
        if (ttl.isZero() || ttl.isNegative()) {
            throw new IllegalArgumentException("The retention time must be positive");
        }
        if (maxOutputBytes < 1 || maxCount < 1 || diskMarginBytes < 0) {
            throw new IllegalArgumentException("The limits must be positive");
        }
        if (budgetBytes < maxOutputBytes) {
            // 2.x refused such limits ("Invalid output limits"): not even one output would fit.
            throw new IllegalArgumentException("The budget must hold at least one output");
        }
    }

    /** The limits of the product. */
    public static OutputLimits defaults() {
        return new OutputLimits(TTL, MAX_OUTPUT_BYTES, BUDGET_BYTES, MAX_COUNT, DISK_MARGIN_BYTES);
    }

    /** The free bytes a disk needs for a reservation; saturates instead of overflowing. */
    public long diskRequiredBytes() {
        return maxOutputBytes > Long.MAX_VALUE - diskMarginBytes ? Long.MAX_VALUE : maxOutputBytes + diskMarginBytes;
    }
}
