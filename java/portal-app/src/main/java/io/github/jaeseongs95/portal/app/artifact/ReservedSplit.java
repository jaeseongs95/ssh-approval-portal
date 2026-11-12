package io.github.jaeseongs95.portal.app.artifact;

/**
 * What the staging budget already holds when a reservation is refused, told apart by who holds it (defect D-0012, design 5.2): the {@code liveBytes} that the rows of
 * the artifacts charge (reservations in flight, staged and consumed files) and the {@code holdingBytes} that stay on the disk without a row (payloads in quarantine).
 * Both count against the same budget, because they use the same disk; the owner needs the two numbers apart because the way to free them differs (wait for the
 * transfers, or clear the quarantine).
 *
 * @param liveBytes the bytes the rows of the artifacts charge
 * @param holdingBytes the bytes held in quarantine
 */
public record ReservedSplit(long liveBytes, long holdingBytes) {

    public ReservedSplit {
        if (liveBytes < 0 || holdingBytes < 0) {
            throw new IllegalArgumentException("The reserved bytes must not be negative");
        }
    }

    /** The two parts together, saturating instead of overflowing. */
    public long totalBytes() {
        return liveBytes > Long.MAX_VALUE - holdingBytes ? Long.MAX_VALUE : liveBytes + holdingBytes;
    }
}
