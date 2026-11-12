package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;

/** How the beginning of a staged upload was answered: it exists (new, or the one a retry with the same key finds) or the reservation was refused with its numbers. */
public sealed interface StagedBegin permits StagedBegin.Begun, StagedBegin.Refused {

    /** The staged file exists in state {@code STAGING}; the client appends chunks to it by this UUID. */
    record Begun(ArtifactUuid uuid) implements StagedBegin {

        public Begun {
            Objects.requireNonNull(uuid, "uuid");
        }
    }

    /** The budget, the disk or the size limit refused the file; nothing was stored. */
    record Refused(ArtifactRefusal refusal) implements StagedBegin {

        public Refused {
            Objects.requireNonNull(refusal, "refusal");
        }
    }
}
