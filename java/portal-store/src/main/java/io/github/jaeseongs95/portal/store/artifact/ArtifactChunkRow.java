package io.github.jaeseongs95.portal.store.artifact;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

/**
 * Table {@code artifact_chunk}: one acknowledged chunk (composite key artifact_id + chunk_no; {@code @Id} is on the first column, so rows are inserted with
 * {@code JdbcAggregateOperations#insert} and never saved or looked up by id).
 */
@Table("artifact_chunk")
public record ArtifactChunkRow(@Id String artifactId, int chunkNo, int sizeBytes, String sha256) {
}
