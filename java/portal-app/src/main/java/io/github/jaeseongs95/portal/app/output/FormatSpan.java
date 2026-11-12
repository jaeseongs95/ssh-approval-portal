package io.github.jaeseongs95.portal.app.output;

import java.util.List;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;

/** Where one rendering lies in the payload file and the SHA-256 of the whole rendering and of each 16 KiB page (2.x {@code formats.*.chunks}). */
public record FormatSpan(long offsetBytes, long sizeBytes, Digest sha256, List<Digest> pageDigests) {

    public FormatSpan {
        Objects.requireNonNull(sha256, "sha256");
        pageDigests = List.copyOf(pageDigests);
        if (offsetBytes < 0 || sizeBytes < 0) {
            throw new IllegalArgumentException("The offset and the size must not be negative");
        }
    }
}
