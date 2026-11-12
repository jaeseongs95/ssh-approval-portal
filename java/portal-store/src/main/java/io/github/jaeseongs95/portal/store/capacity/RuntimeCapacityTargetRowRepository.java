package io.github.jaeseongs95.portal.store.capacity;

import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;

/** Spring Data JDBC repository of the per-target overrides; the rows are replaced as a set (delete all, insert with {@code JdbcAggregateOperations#insert}). */
interface RuntimeCapacityTargetRowRepository extends CrudRepository<RuntimeCapacityTargetRow, String> {

    /** Every override, ordered by target id. */
    @Query("SELECT * FROM runtime_capacity_target ORDER BY target_id")
    List<RuntimeCapacityTargetRow> findAllOrdered();

    /** Deletes every override. */
    @Modifying
    @Query("DELETE FROM runtime_capacity_target")
    int deleteAllTargets();
}
