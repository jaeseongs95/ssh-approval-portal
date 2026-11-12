package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of {@code operation_fence}. */
interface OperationFenceRowRepository extends CrudRepository<OperationFenceRow, String> {

    @Query("SELECT COUNT(*) FROM operation_fence WHERE target_id = :targetId AND target_revision = :targetRevision AND conflict_digest = :conflictDigest")
    long countHolders(@Param("targetId") String targetId, @Param("targetRevision") String targetRevision, @Param("conflictDigest") String conflictDigest);

    @Modifying
    @Query("DELETE FROM operation_fence WHERE operation_id = :operationId")
    int deleteByOperation(@Param("operationId") String operationId);
}
