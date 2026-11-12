package io.github.jaeseongs95.portal.store.artifact;

import java.time.Duration;
import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;

/**
 * The limits of the artifact store: the application's staging budget, the largest single file, the chunk size, how long an unsubmitted upload may stay
 * and how much disk space must stay free after a file is reserved (2.x {@code ports.mjs:2}, {@code artifacts.mjs:61}; defect D-0012 separates the budget from
 * the disk). The product's assembly (portal-server) builds one bean from its settings ({@code BRIDGE_TRANSFER_BUDGET_BYTES}); this module has no property of its
 * own. The constants below are the defaults of the 2.x product.
 *
 * @param budgetBytes       the budget all rows may charge together
 * @param maxFileBytes      the largest declared size of one file; the table's CHECK allows 64 MiB at most
 * @param chunkBytes        the largest chunk the registry accepts
 * @param uploadTimeToLive  how long an upload that nobody submitted stays (the use case passes it in the {@code ArtifactSpec})
 * @param diskMarginBytes   the usable disk space that must remain after the file's bytes are set aside
 */
public record ArtifactLimits(long budgetBytes, long maxFileBytes, int chunkBytes, Duration uploadTimeToLive, long diskMarginBytes) {

    /** 512 MiB: the staging budget of the application. */
    public static final long DEFAULT_BUDGET_BYTES = 512L * 1024 * 1024;
    /** 64 MiB: the largest single file; the same number is the CHECK of {@code artifact.size_bytes}. */
    public static final long MAX_FILE_BYTES = 64L * 1024 * 1024;
    /** 256 KiB: the largest chunk. */
    public static final int CHUNK_BYTES = ChunkDigest.MAX_CHUNK_BYTES;
    /** 10 minutes: an upload that was begun and never submitted. */
    public static final Duration UPLOAD_TTL = Duration.ofMinutes(10);
    /** 64 MiB of disk space that must stay free; an assumption of this implementation, the 2.x product had no margin. */
    public static final long DEFAULT_DISK_MARGIN_BYTES = 64L * 1024 * 1024;

    public ArtifactLimits {
        Objects.requireNonNull(uploadTimeToLive, "uploadTimeToLive");
        if (budgetBytes < 1) {
            throw new IllegalArgumentException("budgetBytes must be positive: " + budgetBytes);
        }
        if (maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("maxFileBytes must be 1 to " + MAX_FILE_BYTES + ": " + maxFileBytes);
        }
        if (chunkBytes < 1 || chunkBytes > CHUNK_BYTES) {
            throw new IllegalArgumentException("chunkBytes must be 1 to " + CHUNK_BYTES + ": " + chunkBytes);
        }
        if (uploadTimeToLive.isNegative() || uploadTimeToLive.isZero()) {
            throw new IllegalArgumentException("uploadTimeToLive must be positive: " + uploadTimeToLive);
        }
        if (diskMarginBytes < 0) {
            throw new IllegalArgumentException("diskMarginBytes must not be negative: " + diskMarginBytes);
        }
    }

    /** The limits of the 2.x product. */
    public static ArtifactLimits defaults() {
        return new ArtifactLimits(DEFAULT_BUDGET_BYTES, MAX_FILE_BYTES, CHUNK_BYTES, UPLOAD_TTL, DEFAULT_DISK_MARGIN_BYTES);
    }
}
