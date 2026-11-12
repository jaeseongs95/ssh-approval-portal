package io.github.jaeseongs95.portal.store.artifact;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactProvenance;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSubmission;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.artifact.ConsumeState;
import io.github.jaeseongs95.portal.app.artifact.ContentDigest;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * Turns the persistence records of the artifact tables into the values of the port and back (design 8.4 {@code ArtifactMapper}). The null column groups of
 * {@link ArtifactRow} become sealed values: no destination, no submission, no consumption, no provenance, a pending digest. A row whose groups are only partly
 * filled is a damaged row and is reported as {@link IllegalStateException}; the table's CHECK constrains the staged group only.
 */
@Component
public class ArtifactMapper {

    /** The new row of a reservation, in state {@code STAGING}, version 0, expiring {@code timeToLive} after {@code at}. */
    public ArtifactRow toNewRow(ArtifactId id, ArtifactSpec spec, Instant at) {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(at, "at");
        ArtifactPurpose purpose = switch (spec.origin()) {
            case ArtifactOrigin.Transfer transfer -> ArtifactPurpose.TRANSFER;
            case ArtifactOrigin.Staged staged -> ArtifactPurpose.STAGED;
        };
        String publicUuid = switch (spec.origin()) {
            case ArtifactOrigin.Transfer transfer -> null;
            case ArtifactOrigin.Staged staged -> staged.publicUuid().text();
        };
        String ownerId = switch (spec.origin()) {
            case ArtifactOrigin.Transfer transfer -> null;
            case ArtifactOrigin.Staged staged -> staged.owner().value();
        };
        String operationKey = switch (spec.origin()) {
            case ArtifactOrigin.Transfer transfer -> null;
            case ArtifactOrigin.Staged staged -> checkedKey(staged.operationKey());
        };
        String remotePath = switch (spec.destination()) {
            case ArtifactDestination.Unassigned unassigned -> null;
            case ArtifactDestination.Assigned assigned -> assigned.path().value();
        };
        String targetId = switch (spec.destination()) {
            case ArtifactDestination.Unassigned unassigned -> null;
            case ArtifactDestination.Assigned assigned -> assigned.targetId().value();
        };
        String targetRevision = switch (spec.destination()) {
            case ArtifactDestination.Unassigned unassigned -> null;
            case ArtifactDestination.Assigned assigned -> assigned.targetRevision().hex();
        };
        BindingKind binding = switch (spec.destination()) {
            case ArtifactDestination.Unassigned unassigned -> BindingKind.UNBOUND;
            case ArtifactDestination.Assigned assigned -> assigned.binding();
        };
        return new ArtifactRow(id.value(), spec.direction(), purpose, ArtifactState.STAGING, publicUuid, ownerId, operationKey, spec.fileName().value(), remotePath,
            spec.sizeBytes(), 0L, 0, null, targetId, targetRevision, binding, spec.protocol(), spec.overwrite(), spec.elevation(), spec.retention(),
            at.plus(spec.timeToLive()), null, null, null, null, null, 0L, at);
    }

    public ArtifactRecord toRecord(ArtifactRow row) {
        Objects.requireNonNull(row, "row");
        return new ArtifactRecord(new ArtifactId(row.id()), toSpec(row), row.state(), row.receivedBytes(), row.chunkCount(), toContent(row), toSubmission(row),
            toProvenance(row), toConsumption(row), row.version(), row.createdAt(), row.expiresAt());
    }

    public ArtifactChunkRow toChunkRow(ArtifactId id, int chunkNo, ChunkDigest chunk) {
        return new ArtifactChunkRow(id.value(), chunkNo, chunk.sizeBytes(), chunk.sha256().hex());
    }

    public ChunkDigest toChunk(ArtifactChunkRow row) {
        return new ChunkDigest(row.sizeBytes(), new Digest(row.sha256()));
    }

    public StagedActionRow toActionRow(StagedAction action) {
        return new StagedActionRow(action.artifactId().value(), action.operationKey(), action.requestKey().value(), action.inputDigest().hex(),
            action.requestId().value(), action.kind(), action.state(), action.targetId().value(), action.targetRevision().hex(), action.remotePath().value(),
            action.overwrite(), action.elevation());
    }

    public StagedAction toAction(StagedActionRow row) {
        return new StagedAction(new ArtifactId(row.artifactId()), row.operationKey(), new RequestKey(row.requestKey()), new Digest(row.inputDigest()),
            new OperationId(row.requestId()), row.action(), row.state(), new TargetId(row.targetId()), TargetRevision.of(row.targetRevision()),
            RemotePath.parse(row.remotePath()), row.overwriteMode(), row.elevation());
    }

    /** The operation key of a staged file has the shape of a request key (16 to 128 characters, no line break); the store is the boundary that checks it (RC-B-092). */
    private String checkedKey(String operationKey) {
        try {
            return new RequestKey(operationKey).value();
        } catch (IllegalArgumentException e) {
            throw new RequestRefusedException(ArtifactErrorCode.INVALID_OPERATION_KEY, e);
        }
    }

    private ArtifactSpec toSpec(ArtifactRow row) {
        return new ArtifactSpec(row.direction(), new FileName(row.fileName()), row.sizeBytes(), toOrigin(row), toDestination(row), row.overwriteMode(),
            row.elevation(), row.uploadProtocol(), row.retention(), Duration.between(row.createdAt(), row.expiresAt()));
    }

    private ArtifactOrigin toOrigin(ArtifactRow row) {
        return switch (row.purpose()) {
            case TRANSFER -> new ArtifactOrigin.Transfer();
            case STAGED -> new ArtifactOrigin.Staged(ArtifactUuid.parse(row.publicUuid()), new OwnerId(row.ownerId()), row.operationKey());
        };
    }

    private ArtifactDestination toDestination(ArtifactRow row) {
        boolean path = row.remotePath() != null;
        boolean target = row.targetId() != null;
        boolean revision = row.targetRevision() != null;
        if (!path && !target && !revision) {
            return new ArtifactDestination.Unassigned();
        }
        if (!path || !target || !revision) {
            throw new IllegalStateException("Artifact row " + row.id() + " has a partial destination");
        }
        return new ArtifactDestination.Assigned(RemotePath.parse(row.remotePath()), new TargetId(row.targetId()), TargetRevision.of(row.targetRevision()),
            row.fileTargetBinding());
    }

    private ContentDigest toContent(ArtifactRow row) {
        return row.sha256() == null ? new ContentDigest.Pending() : new ContentDigest.Sealed(new Digest(row.sha256()));
    }

    private ArtifactSubmission toSubmission(ArtifactRow row) {
        return row.submissionId() == null ? new ArtifactSubmission.NotSubmitted() : new ArtifactSubmission.SubmittedAs(new OperationId(row.submissionId()));
    }

    private ArtifactProvenance toProvenance(ArtifactRow row) {
        boolean source = row.provenanceSourceUuid() != null;
        boolean owner = row.provenanceOwnerId() != null;
        boolean request = row.provenanceRequestId() != null;
        if (!source && !owner && !request) {
            return new ArtifactProvenance.NoProvenance();
        }
        if (!source || !owner || !request) {
            throw new IllegalStateException("Artifact row " + row.id() + " has a partial provenance");
        }
        return new ArtifactProvenance.DerivedFrom(ArtifactUuid.parse(row.provenanceSourceUuid()), new OwnerId(row.provenanceOwnerId()),
            new OperationId(row.provenanceRequestId()));
    }

    private ConsumeState toConsumption(ArtifactRow row) {
        return row.consumeReason() == null ? new ConsumeState.NotConsumed() : new ConsumeState.ConsumedBecause(row.consumeReason());
    }
}
