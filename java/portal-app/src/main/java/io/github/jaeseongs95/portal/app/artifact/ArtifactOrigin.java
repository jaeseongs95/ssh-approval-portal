package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.OwnerId;

/** Whether an artifact is a plain transfer or a staged file with a public UUID, an owner and an operation key (2.x {@code purpose === 'staged'}). */
public sealed interface ArtifactOrigin permits ArtifactOrigin.Transfer, ArtifactOrigin.Staged {

    /** A transfer made for one operation. */
    record Transfer() implements ArtifactOrigin {
    }

    /** A staged file the owner may use in several actions. The pair (owner, operationKey) is unique. */
    record Staged(ArtifactUuid publicUuid, OwnerId owner, String operationKey) implements ArtifactOrigin {

        public Staged {
            Objects.requireNonNull(publicUuid, "publicUuid");
            Objects.requireNonNull(owner, "owner");
            Objects.requireNonNull(operationKey, "operationKey");
            if (operationKey.isBlank() || operationKey.length() > 128) {
                throw new IllegalArgumentException("operationKey must be 1 to 128 characters");
            }
        }
    }
}
