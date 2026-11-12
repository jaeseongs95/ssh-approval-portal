package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.OperationId;

/** The operation that was made from an artifact, if any (2.x {@code submissionId}). */
public sealed interface ArtifactSubmission permits ArtifactSubmission.NotSubmitted, ArtifactSubmission.SubmittedAs {

    record NotSubmitted() implements ArtifactSubmission {
    }

    record SubmittedAs(OperationId operationId) implements ArtifactSubmission {

        public SubmittedAs {
            Objects.requireNonNull(operationId, "operationId");
        }
    }
}
