package io.github.jaeseongs95.portal.store.artifact;

import java.util.List;
import java.util.Optional;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;

/**
 * The reads that the start-up check and the use case need and that {@code ArtifactRegistry} does not offer: every row that may hold bytes, the acknowledged chunk
 * digests of one artifact, and the staged file of an owner and operation key (the retry of a begin that must answer with the same public UUID, RC-B-091).
 * {@link JdbcArtifactRegistry} implements both interfaces. The methods are a request to move into {@code ArtifactRegistry} (reported as a need); they live here
 * until the port owner decides, so that portal-app stays unchanged by this module.
 */
public interface ArtifactInventory {

    /** Every artifact that can hold bytes: all states except {@code CONSUMED} (a consumed row keeps its metadata only). */
    List<ArtifactRecord> holding();

    /** The acknowledged chunks of the artifact in chunk-number order; empty when there is none or the artifact is unknown. */
    List<ChunkDigest> chunks(ArtifactId id);

    /** {@code Optional} here has the one meaning "no staged file for this owner and key". */
    Optional<ArtifactRecord> findStagedByKey(OwnerId owner, String operationKey);
}
