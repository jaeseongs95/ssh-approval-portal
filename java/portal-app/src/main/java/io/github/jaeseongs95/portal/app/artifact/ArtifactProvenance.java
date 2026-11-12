package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;

/** The staged file a transfer was copied from, if any (2.x {@code provenance}: three fields, all or none). */
public sealed interface ArtifactProvenance permits ArtifactProvenance.NoProvenance, ArtifactProvenance.DerivedFrom {

    record NoProvenance() implements ArtifactProvenance {
    }

    record DerivedFrom(ArtifactUuid sourceUuid, OwnerId owner, OperationId request) implements ArtifactProvenance {

        public DerivedFrom {
            Objects.requireNonNull(sourceUuid, "sourceUuid");
            Objects.requireNonNull(owner, "owner");
            Objects.requireNonNull(request, "request");
        }
    }
}
