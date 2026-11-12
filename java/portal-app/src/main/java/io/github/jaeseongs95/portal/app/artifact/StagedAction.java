package io.github.jaeseongs95.portal.app.artifact;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/** One use of a staged file (2.x {@code meta.actions[]}, {@code artifacts.mjs:31-35}); the pair (artifact, operationKey) is unique. */
public record StagedAction(ArtifactId artifactId, String operationKey, RequestKey requestKey, Digest inputDigest, OperationId requestId, StagedActionKind kind,
                           StagedActionState state, TargetId targetId, TargetRevision targetRevision, RemotePath remotePath, OverwriteMode overwrite, Elevation elevation) {

    public StagedAction {
        Objects.requireNonNull(artifactId, "artifactId");
        Objects.requireNonNull(operationKey, "operationKey");
        Objects.requireNonNull(requestKey, "requestKey");
        Objects.requireNonNull(inputDigest, "inputDigest");
        Objects.requireNonNull(requestId, "requestId");
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(targetId, "targetId");
        Objects.requireNonNull(targetRevision, "targetRevision");
        Objects.requireNonNull(remotePath, "remotePath");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(elevation, "elevation");
    }
}
