package io.github.jaeseongs95.portal.app.artifact;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The metadata and the budget of the artifacts (2.x {@code artifacts.mjs}, manifest files {@code <id>.json}). The bytes are {@link ArtifactPayloadStore}'s: the
 * use case writes the bytes first and the metadata second (design 8.5, "bytes forced to disk, then metadata commit"), so a crash leaves at worst a byte tail that the
 * start-up check truncates. No method of this interface touches a file, so each runs in one short transaction.
 */
public interface ArtifactRegistry {

    /**
     * Reserves the budget and creates the row in {@code STAGING}. The three refusals are answered, not thrown. The registry reads the usable disk space through
     * {@link ArtifactPayloadStore#usable()}, which is a read, not a payload write.
     */
    ArtifactReservation reserve(ArtifactSpec spec, Instant at);

    /** Acknowledges the next chunk ({@code chunkNo} is the count so far); a chunk number out of order throws {@code ARTIFACT_CHUNK_CONFLICT}. */
    ArtifactRecord append(ArtifactId id, int chunkNo, ChunkDigest chunk);

    /** {@code STAGING} to {@code READY} once all bytes arrived and the whole-file digest is known. */
    ArtifactRecord markReady(ArtifactId id, Digest sha256);

    /** {@code Optional} here has the one meaning "no such artifact". */
    Optional<ArtifactRecord> find(ArtifactId id);

    Optional<ArtifactRecord> findStaged(ArtifactUuid publicUuid);

    ArtifactBudget budget();

    /** Releasable artifacts whose expiry is not after {@code now}; pinned ones are never listed. */
    List<ArtifactRecord> expired(Instant now);

    /** Records that an operation was made from the artifact. */
    ArtifactRecord submit(ArtifactId id, OperationId operationId);

    /** {@code READY} to {@code CONSUMING}: a staged file starts to be moved or removed. */
    ArtifactRecord beginConsume(ArtifactId id);

    /** {@code CONSUMING} to {@code CONSUMED}; the row stays and charges one byte. */
    ArtifactRecord completeConsume(ArtifactId id, ConsumeReason reason);

    /** Marks the row {@code DELETING} before the bytes are deleted; the row is removed by {@link #release}. */
    ArtifactRecord beginDelete(ArtifactId id);

    /** Removes the row and gives its budget back. */
    void release(ArtifactId id, ReleaseReason reason);

    void addAction(StagedAction action);

    List<StagedAction> actions(ArtifactId id);

    void updateAction(ArtifactId id, String operationKey, StagedActionState state);
}
