package io.github.jaeseongs95.portal.app.file;

import java.util.Objects;

import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * A copy or a move of a staged file to a path on a target (2.x {@code transfer}). The owner is the verified owner of the request, never a field the client wrote; the
 * operation key makes the request repeatable (the same key with the same content is the same action); the expected revision is what the client saw of the target.
 *
 * @param owner who owns the staged file
 * @param uuid the public id of the staged file
 * @param kind copy (the staged file stays) or move (it is consumed once the publication is confirmed)
 * @param operationKey 16 to 128 characters of {@code A-Za-z0-9_.:-}, no line break
 * @param target the target as configured now
 * @param expectedRevision the revision of the target the client saw
 * @param remotePath where the file goes
 * @param overwrite what to do when the file exists
 * @param elevation whether the write is elevated
 */
public record StagedPlacementRequest(OwnerId owner, ArtifactUuid uuid, StagedActionKind kind, String operationKey, ResolvedTarget target, TargetRevision expectedRevision,
                                     RemotePath remotePath, OverwriteMode overwrite, Elevation elevation) {

    public StagedPlacementRequest {
        Objects.requireNonNull(owner, "owner");
        Objects.requireNonNull(uuid, "uuid");
        Objects.requireNonNull(kind, "kind");
        Objects.requireNonNull(operationKey, "operationKey");
        Objects.requireNonNull(target, "target");
        Objects.requireNonNull(expectedRevision, "expectedRevision");
        Objects.requireNonNull(remotePath, "remotePath");
        Objects.requireNonNull(overwrite, "overwrite");
        Objects.requireNonNull(elevation, "elevation");
    }
}
