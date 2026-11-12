package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

/**
 * How the import of a stream into an artifact ended (RC-A-182, RC-A-183). Whatever the answer, a failed or refused import leaves no file and no charge: the reserved
 * bytes are given back and the bytes written so far are deleted before the answer is returned.
 */
public sealed interface ImportResult permits ImportResult.Imported, ImportResult.Refused, ImportResult.Failed {

    /** The bytes are stored, counted and hashed, and the artifact is {@code READY}. */
    record Imported(ArtifactRecord artifact) implements ImportResult {

        public Imported {
            Objects.requireNonNull(artifact, "artifact");
        }
    }

    /** The reservation was refused before the source was opened; the source was never touched. */
    record Refused(ArtifactRefusal refusal) implements ImportResult {

        public Refused {
            Objects.requireNonNull(refusal, "refusal");
        }
    }

    /** The reservation was made and the import failed after it. */
    record Failed(Reason reason) implements ImportResult {

        public Failed {
            Objects.requireNonNull(reason, "reason");
        }
    }

    /** Why an import failed. */
    enum Reason {
        /** The source could not be opened, or its read broke before the end. */
        SOURCE_FAILED,
        /** The source gave more bytes than were declared, or fewer. */
        SIZE_MISMATCH,
        /** The bytes read do not have the digest that was expected of them. */
        DIGEST_MISMATCH,
        /** The artifact store failed while the bytes were written. */
        LOCAL_IO_FAILED
    }
}
