package io.github.jaeseongs95.portal.store.artifact;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;

/**
 * Table {@code artifact}: the metadata of one artifact (2.x manifest {@code <id>.json}). The nullable columns are nullable properties of this persistence record,
 * which no other layer sees; {@link ArtifactMapper} turns the null groups into the sealed values of the port. {@code version} is the optimistic-lock counter,
 * advanced by {@code ArtifactRowRepository#bumpVersion} (no {@code @Version} annotation, design 8.1 is replaced by the lead's CAS-step convention).
 * The {@code with...} methods copy the row with the fields a transition changes; the caller passes the version that the CAS step wrote.
 */
@Table("artifact")
public record ArtifactRow(@Id String id, ArtifactDirection direction, ArtifactPurpose purpose, ArtifactState state, String publicUuid, String ownerId,
                          String operationKey, String fileName, String remotePath, long sizeBytes, long receivedBytes, int chunkCount, String sha256,
                          String targetId, String targetRevision, BindingKind fileTargetBinding, UploadProtocol uploadProtocol, OverwriteMode overwriteMode,
                          Elevation elevation, ArtifactRetention retention, Instant expiresAt, String submissionId, ConsumeReason consumeReason,
                          String provenanceSourceUuid, String provenanceOwnerId, String provenanceRequestId, long version, Instant createdAt) {

    /** One more chunk of {@code chunkSize} bytes was acknowledged. */
    public ArtifactRow withChunk(int chunkSize, long nextVersion) {
        return changing(state, receivedBytes + chunkSize, chunkCount + 1, sha256, retention, submissionId, consumeReason, nextVersion);
    }

    /** The state moves to {@code next}; everything else stays. */
    public ArtifactRow withState(ArtifactState next, long nextVersion) {
        return changing(next, receivedBytes, chunkCount, sha256, retention, submissionId, consumeReason, nextVersion);
    }

    /** All bytes arrived and the whole-file digest is {@code digestHex}: the row is {@code READY}. */
    public ArtifactRow ready(String digestHex, long nextVersion) {
        return changing(ArtifactState.READY, receivedBytes, chunkCount, digestHex, retention, submissionId, consumeReason, nextVersion);
    }

    /** A download is complete: its size is what was received (the reservation held the largest size a transfer may have), and the row is {@code READY}. */
    public ArtifactRow downloaded(String digestHex, long nextVersion) {
        return new ArtifactRow(id, direction, purpose, ArtifactState.READY, publicUuid, ownerId, operationKey, fileName, remotePath, receivedBytes, receivedBytes, chunkCount,
            digestHex, targetId, targetRevision, fileTargetBinding, uploadProtocol, overwriteMode, elevation, retention, expiresAt, submissionId, consumeReason,
            provenanceSourceUuid, provenanceOwnerId, provenanceRequestId, nextVersion, createdAt);
    }

    /** An operation was made from the artifact; it is pinned for as long as the operation depends on it. */
    public ArtifactRow submittedAs(String operationId, long nextVersion) {
        return changing(state, receivedBytes, chunkCount, sha256, ArtifactRetention.PINNED, operationId, consumeReason, nextVersion);
    }

    /** The use of the staged file starts for {@code reason}: the state is {@code CONSUMING} and the reason is already recorded. */
    public ArtifactRow consumingBecause(ConsumeReason reason, long nextVersion) {
        return changing(ArtifactState.CONSUMING, receivedBytes, chunkCount, sha256, retention, submissionId, reason, nextVersion);
    }

    /** The operation that depended on the artifact is over: the owner no longer keeps it, so the expiry applies again. */
    public ArtifactRow unpinned(long nextVersion) {
        return changing(state, receivedBytes, chunkCount, sha256, ArtifactRetention.RELEASABLE, submissionId, consumeReason, nextVersion);
    }

    /** The staged file was used up for {@code reason}. */
    public ArtifactRow consumedBecause(ConsumeReason reason, long nextVersion) {
        return changing(ArtifactState.CONSUMED, receivedBytes, chunkCount, sha256, retention, submissionId, reason, nextVersion);
    }

    private ArtifactRow changing(ArtifactState nextState, long nextReceivedBytes, int nextChunkCount, String nextSha256, ArtifactRetention nextRetention,
                                 String nextSubmissionId, ConsumeReason nextConsumeReason, long nextVersion) {
        return new ArtifactRow(id, direction, purpose, nextState, publicUuid, ownerId, operationKey, fileName, remotePath, sizeBytes, nextReceivedBytes,
            nextChunkCount, nextSha256, targetId, targetRevision, fileTargetBinding, uploadProtocol, overwriteMode, elevation, nextRetention, expiresAt,
            nextSubmissionId, nextConsumeReason, provenanceSourceUuid, provenanceOwnerId, provenanceRequestId, nextVersion, createdAt);
    }
}
