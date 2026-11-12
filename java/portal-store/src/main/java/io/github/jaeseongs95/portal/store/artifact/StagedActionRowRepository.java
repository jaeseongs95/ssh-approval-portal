package io.github.jaeseongs95.portal.store.artifact;

import java.util.List;
import java.util.Optional;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the staged-action rows (composite key: insert with {@code JdbcAggregateOperations}, change and remove by statement). */
interface StagedActionRowRepository extends CrudRepository<StagedActionRow, String> {

    List<StagedActionRow> findByArtifactIdOrderByOperationKey(String artifactId);

    @Query("SELECT * FROM staged_action WHERE artifact_id = :id AND operation_key = :key")
    Optional<StagedActionRow> findOne(@Param("id") String id, @Param("key") String key);

    /** Moves the action to {@code next} when it still is in {@code current}; returns 1 or 0 (a concurrent change). */
    @Modifying
    @Query("UPDATE staged_action SET state = :next WHERE artifact_id = :id AND operation_key = :key AND state = :current")
    int moveState(@Param("id") String id, @Param("key") String key, @Param("current") String current, @Param("next") String next);

    @Modifying
    @Query("DELETE FROM staged_action WHERE artifact_id = :id")
    int deleteAllOf(@Param("id") String id);
}
