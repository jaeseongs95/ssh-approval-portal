package io.github.jaeseongs95.portal.app.artifact;

import java.time.Instant;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;

/**
 * A stored artifact: what it was reserved as, the state, how many bytes and chunks the registry has acknowledged, and the optimistic-lock version. The metadata is
 * copied on every read, so a caller never holds the registry's row.
 */
public record ArtifactRecord(ArtifactId id, ArtifactSpec spec, ArtifactState state, long receivedBytes, int chunkCount, ContentDigest content,
                             ArtifactSubmission submission, ArtifactProvenance provenance, ConsumeState consumption, long version, Instant createdAt, Instant expiresAt) {

    public ArtifactRecord {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(content, "content");
        Objects.requireNonNull(submission, "submission");
        Objects.requireNonNull(provenance, "provenance");
        Objects.requireNonNull(consumption, "consumption");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(expiresAt, "expiresAt");
        if (receivedBytes < 0 || receivedBytes > spec.sizeBytes()) {
            throw new IllegalArgumentException("receivedBytes must be between 0 and the declared size: " + receivedBytes);
        }
        if (chunkCount < 0) {
            throw new IllegalArgumentException("chunkCount must not be negative: " + chunkCount);
        }
    }
}
