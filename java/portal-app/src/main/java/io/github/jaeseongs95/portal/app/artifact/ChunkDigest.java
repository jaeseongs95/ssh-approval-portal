package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;

/** One acknowledged chunk of an artifact: its size (1 byte to 256 KiB) and the SHA-256 of its bytes (2.x {@code chunks[]}). */
public record ChunkDigest(int sizeBytes, Digest sha256) {

    public static final int MAX_CHUNK_BYTES = 256 * 1024;

    public ChunkDigest {
        Objects.requireNonNull(sha256, "sha256");
        if (sizeBytes < 1 || sizeBytes > MAX_CHUNK_BYTES) {
            throw new IllegalArgumentException("A chunk is 1 to " + MAX_CHUNK_BYTES + " bytes: " + sizeBytes);
        }
    }
}
