package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jdbc.repository.query.Modifying;
import org.springframework.data.jdbc.repository.query.Query;
import org.springframework.data.repository.CrudRepository;
import org.springframework.data.repository.query.Param;

import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * Spring Data JDBC repository of the {@code operation} table. The limits of a list are a {@link Pageable} argument of a derived query, which the dialect turns into
 * the limit syntax of the database in use; a {@code @Query} string supports no limit (Spring Data JDBC reference, "Query Methods"). The statements that remain
 * are ANSI.
 */
interface OperationRowRepository extends CrudRepository<OperationRow, String> {

    Optional<OperationRow> findByRequestKey(String requestKey);

    long countByState(OperationState state);

    long countByStateIn(Collection<OperationState> states);

    long countByTargetIdAndStateIn(String targetId, Collection<OperationState> states);

    /** Unknown operations that are not imported 2.x history (the live unknown budget). */
    @Query("SELECT COUNT(*) FROM operation o WHERE o.state = 'UNKNOWN' AND o.id NOT IN (SELECT l.operation_id FROM operation_legacy l)")
    long countLiveUnknown();

    /** The first step of every compare-and-set: the row lock and the version check in one statement; 1 row when the stored version is {@code expected}. */
    @Modifying
    @Query("UPDATE operation SET version = :next WHERE id = :id AND version = :expected")
    int bumpVersion(@Param("id") String id, @Param("expected") long expected, @Param("next") long next);

    /** The largest ready sequence in use; the next position is this plus one. */
    @Query("SELECT COALESCE(MAX(ready_sequence), 0) FROM operation")
    long maxReadySequence();

    List<OperationRow> findByStateOrderByReadySequenceAsc(OperationState state, Pageable page);

    List<OperationRow> findByStateInOrderByCreatedAtAscIdAsc(Collection<OperationState> states, Pageable page);

    List<OperationRow> findByTargetIdAndStateInOrderByCreatedAtAscIdAsc(String targetId, Collection<OperationState> states, Pageable page);

    Optional<OperationRow> findFirstByTargetIdAndStartedAtIsNotNullOrderByStartedAtDesc(String targetId);

    /** Every operation that a restart has to close, whatever the state set (the caller passes it). */
    List<OperationRow> findByStateIn(Collection<OperationState> states);

    // History, newest first, keyset on (created_at, id). The predicate "created_at < c OR (created_at = c AND id < i)" is read in two derived queries and merged by
    // JdbcHistoryQuery (the rows of the same instant come first), so every query stays a simple derived query with a limit.
    List<OperationRow> findByStateInOrderByCreatedAtDescIdDesc(Collection<OperationState> states, Pageable page);

    List<OperationRow> findByStateInAndCreatedAtBeforeOrderByCreatedAtDescIdDesc(Collection<OperationState> states, Instant before, Pageable page);

    List<OperationRow> findByStateInAndCreatedAtAndIdLessThanOrderByIdDesc(Collection<OperationState> states, Instant at, String id, Pageable page);

    List<OperationRow> findByTargetIdAndStateInOrderByCreatedAtDescIdDesc(String targetId, Collection<OperationState> states, Pageable page);

    List<OperationRow> findByTargetIdAndStateInAndCreatedAtBeforeOrderByCreatedAtDescIdDesc(String targetId, Collection<OperationState> states, Instant before,
                                                                                            Pageable page);

    List<OperationRow> findByTargetIdAndStateInAndCreatedAtAndIdLessThanOrderByIdDesc(String targetId, Collection<OperationState> states, Instant at, String id,
                                                                                      Pageable page);
}
