package io.github.jaeseongs95.portal.store.output;

import java.time.Instant;
import java.util.List;

import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

import io.github.jaeseongs95.portal.app.output.OutputState;

/**
 * Spring Data JDBC repository of the output manifests. The statements are ANSI SQL. Rows are inserted and updated with {@code JdbcAggregateOperations}, not saved
 * (the id is made by the application); the version is raised first by {@link #bumpVersion}, a compare-and-set that tells two racing writers apart.
 */
interface CommandOutputRowRepository extends CrudRepository<CommandOutputRow, String> {

    /** Moves the version from {@code expected} to {@code next}; returns the number of rows changed (1, or 0 when another writer was first). */
    @Modifying
    @Query("UPDATE command_output SET version = :next WHERE id = :id AND version = :expected")
    int bumpVersion(@Param("id") String id, @Param("expected") long expected, @Param("next") long next);

    /** The sum of the charges of all outputs (2.x {@code coalesce(sum(charge),0)}). */
    @Query("SELECT COALESCE(SUM(charge_bytes), 0) FROM command_output")
    long totalCharge();

    /** The outputs whose expiry is not after {@code now}. */
    List<CommandOutputRow> findByExpiresAtLessThanEqual(Instant now);

    List<CommandOutputRow> findByState(OutputState state);

    @Modifying
    @Query("DELETE FROM command_output WHERE id = :id")
    int removeById(@Param("id") String id);
}
