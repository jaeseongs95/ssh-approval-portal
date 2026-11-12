package io.github.jaeseongs95.portal.store.policy;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

/** Spring Data JDBC repository of the policy revision row. The compare-and-set is one conditional UPDATE (2.x {@code command-state.mjs}, revision check). */
interface CommandPolicyRowRepository extends CrudRepository<CommandPolicyRow, Integer> {

    /** Raises the revision by one when it is still {@code expected}; returns the number of rows changed (1 for the winner, 0 for a stale writer). */
    @Modifying
    @Query("UPDATE command_policy SET revision = revision + 1 WHERE id = 1 AND revision = :expected")
    int advanceRevision(@Param("expected") long expected);
}
