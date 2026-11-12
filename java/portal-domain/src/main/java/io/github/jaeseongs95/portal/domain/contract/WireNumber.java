package io.github.jaeseongs95.portal.domain.contract;

/**
 * The integer ranges the public contract fixes. A wire integer is a JSON number a JavaScript client reads exactly, so the baseline caps every integer at
 * 2^53 - 1 ({@code nint}, {@code pint}); the sizes of a transfer and a page have their own caps (public-contract.mjs:19-20, 61-67, {@code MAX_BYTES} and
 * {@code CHUNK_BYTES}). Each constant owns one range and judges a value against it.
 *
 * <p>It is package-private on purpose: the records of this package use it to refuse an out-of-range value at construction.
 */
enum WireNumber {
    /** {@code nint}: zero or more, at most 2^53 - 1. */
    NON_NEGATIVE(0L, 9_007_199_254_740_991L),
    /** {@code pint}: one or more, at most 2^53 - 1. */
    POSITIVE(1L, 9_007_199_254_740_991L),
    /** An integer that may be negative (an exit code), at most 2^53 - 1 in size. */
    SIGNED(-9_007_199_254_740_991L, 9_007_199_254_740_991L),
    /** The size of a staged or uploaded artifact: at most 64 MiB (67108864). */
    ARTIFACT_BYTES(0L, 67_108_864L),
    /** The size of one chunk or one page of artifact bytes: at most 256 KiB (262144). */
    CHUNK_BYTES(0L, 262_144L);

    private final long min;
    private final long max;

    WireNumber(long min, long max) {
        this.min = min;
        this.max = max;
    }

    long min() {
        return min;
    }

    long max() {
        return max;
    }

    /** Refuses a value outside the range. */
    void require(long value, String field) {
        if (value < min || value > max) {
            throw new IllegalArgumentException(field + " is outside the contract range " + name() + " [" + min + ", " + max + "]");
        }
    }

    /** Like {@link #require} but a null value is the wire null and passes. */
    void requireOrNull(Long value, String field) {
        if (value != null) {
            require(value, field);
        }
    }
}
