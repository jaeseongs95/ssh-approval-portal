package io.github.jaeseongs95.portal.store.capacity;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the capacity row. The compare-and-set is one conditional UPDATE on the contract revision (2.x {@code runtime-capacity-state.mjs}). */
interface RuntimeCapacityRowRepository extends CrudRepository<RuntimeCapacityRow, Integer> {

    /** Writes the next state when the stored revision is still {@code expected}; returns the number of rows changed (1 for the winner, 0 for a stale writer). */
    @Modifying
    @Query("UPDATE runtime_capacity SET revision = :next, queue_capacity = :queue, max_concurrency = :concurrency, version = version + 1 WHERE id = 1 AND revision = :expected")
    int replaceIfRevision(@Param("expected") String expected, @Param("next") String next, @Param("queue") int queue, @Param("concurrency") int concurrency);
}
