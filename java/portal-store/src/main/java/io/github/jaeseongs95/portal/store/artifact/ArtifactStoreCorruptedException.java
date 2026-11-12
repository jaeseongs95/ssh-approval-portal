package io.github.jaeseongs95.portal.store.artifact;

import java.io.Serial;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;

/**
 * The start-up check found bytes that the metadata cannot explain and that cannot be repaired by cutting a tail: the file is shorter than the acknowledged
 * length, a chunk's hash differs, or the file cannot be read. The start is refused (design 8.5 rule c, 2.x {@code artifacts.mjs:130-144}); it is not a request
 * refusal, so it is not a {@code PortalException}. The message is a fixed sentence per reason.
 */
public final class ArtifactStoreCorruptedException extends IllegalStateException {

    /** What is wrong with the payload. */
    public enum Reason {
        PAYLOAD_SHORTER, CHUNK_MISMATCH, PAYLOAD_UNREADABLE
    }

    @Serial
    private static final long serialVersionUID = 1L;

    /** The id as text: an exception is {@code Serializable} and {@link ArtifactId} is a plain record (-Xlint:serial). */
    private final String artifactIdText;
    private final Reason reason;

    public ArtifactStoreCorruptedException(ArtifactId artifactId, Reason reason, Throwable cause) {
        super("The stored bytes of an artifact do not match its metadata: " + Objects.requireNonNull(reason, "reason").name(), cause);
        this.artifactIdText = Objects.requireNonNull(artifactId, "artifactId").value();
        this.reason = reason;
    }

    public ArtifactStoreCorruptedException(ArtifactId artifactId, Reason reason) {
        this(artifactId, reason, null);
    }

    public ArtifactId artifactId() {
        return new ArtifactId(artifactIdText);
    }

    public Reason reason() {
        return reason;
    }
}
