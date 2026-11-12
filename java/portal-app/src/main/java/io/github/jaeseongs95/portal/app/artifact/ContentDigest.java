package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;

/** The SHA-256 of the whole artifact: unknown while it is staged, known once it is ready. */
public sealed interface ContentDigest permits ContentDigest.Pending, ContentDigest.Sealed {

    record Pending() implements ContentDigest {
    }

    record Sealed(Digest sha256) implements ContentDigest {

        public Sealed {
            Objects.requireNonNull(sha256, "sha256");
        }
    }
}
