package io.github.jaeseongs95.portal.store.artifact;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the chunk rows (composite key: rows are inserted with {@code JdbcAggregateOperations}, removed by statement). */
interface ArtifactChunkRowRepository extends CrudRepository<ArtifactChunkRow, String> {

    List<ArtifactChunkRow> findByArtifactIdOrderByChunkNo(String artifactId);

    @Modifying
    @Query("DELETE FROM artifact_chunk WHERE artifact_id = :id")
    int deleteAllOf(@Param("id") String id);
}
