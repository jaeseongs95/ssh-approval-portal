package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;
import java.util.Objects;

import org.springframework.data.jdbc.core.JdbcAggregateOperations;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import io.github.jaeseongs95.portal.app.history.ExecutionTimelineStore;
import io.github.jaeseongs95.portal.app.remote.ExecutionPhase;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * {@link ExecutionTimelineStore} over the three nullable columns that the migration V7 added to {@code operation_result}: {@code exec_connected_at},
 * {@code exec_dispatched_at} and {@code exec_closed_at}. The columns are written by one UPDATE of the result row; the outcome itself is not touched, and a result that
 * is stored again (see {@code OperationStorage}) keeps them.
 */
@Repository
public class JdbcExecutionTimelineStore implements ExecutionTimelineStore {

    private final OperationResultRowRepository results;
    private final JdbcAggregateOperations aggregates;

    public JdbcExecutionTimelineStore(OperationResultRowRepository results, JdbcAggregateOperations aggregates) {
        this.results = results;
        this.aggregates = aggregates;
    }

    @Override
    @Transactional
    public void record(OperationId operationId, ExecutionTimeline timeline) {
        Objects.requireNonNull(operationId, "operationId");
        Objects.requireNonNull(timeline, "timeline");
        OperationResultRow row = results.findById(operationId.value()).orElseThrow(() -> new RequestRefusedException(OperationErrorCode.INVALID_OPERATION_RECORD));
        aggregates.update(row.withTimeline(instantOf(timeline, ExecutionPhase.CONNECTED), instantOf(timeline, ExecutionPhase.REQUEST_SENT),
            instantOf(timeline, ExecutionPhase.CLOSED)));
    }

    @Override
    @Transactional(readOnly = true)
    public ExecutionTimeline timelineOf(OperationId operationId) {
        Objects.requireNonNull(operationId, "operationId");
        return results.findById(operationId.value()).map(this::timelineOf).orElseGet(ExecutionTimeline::empty);
    }

    private ExecutionTimeline timelineOf(OperationResultRow row) {
        ExecutionTimeline timeline = ExecutionTimeline.empty();
        if (row.execConnectedAt() != null) {
            timeline = timeline.marked(ExecutionPhase.CONNECTED, row.execConnectedAt());
        }
        if (row.execDispatchedAt() != null) {
            timeline = timeline.marked(ExecutionPhase.REQUEST_SENT, row.execDispatchedAt());
        }
        if (row.execClosedAt() != null) {
            timeline = timeline.marked(ExecutionPhase.CLOSED, row.execClosedAt());
        }
        return timeline;
    }

    /** The persistence record's nullable column: {@code null} means the phase was not reached. */
    private Instant instantOf(ExecutionTimeline timeline, ExecutionPhase phase) {
        return timeline.at(phase).orElse(null);
    }
}
