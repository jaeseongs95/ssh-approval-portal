package io.github.jaeseongs95.portal.app.history;

import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/**
 * The instants of one execution that outlive the process (defect D-0038, stage 3 design 3.4): when the session was ready, when the request was sent, when the channel
 * was closed. The operation journal keeps the time of each state change; this keeps the time <em>between</em> the steps of one execution, so that a connection that
 * failed at once can be told from one that was lost later.
 *
 * <p>Three of the phases of {@link ExecutionTimeline} are stored: {@code CONNECTED}, {@code REQUEST_SENT} and {@code CLOSED}. The others (connect started, channel
 * opened, first output, exit seen) are for the log. The use case that runs the execution calls {@link #record} once, after the operation settled and its result is in
 * the journal (the instants belong to the result of an execution that ran, so an operation without such a result has nowhere to keep them).
 */
public interface ExecutionTimelineStore {

    /**
     * Stores the stored phases of the timeline with the result of the operation. A phase that is not in the timeline is stored as "not reached", so a second call
     * with another timeline replaces the first. An operation that has no executed result throws {@code RequestRefusedException(INVALID_OPERATION_RECORD)}.
     */
    void record(OperationId operationId, ExecutionTimeline timeline);

    /**
     * The stored phases in the order they happened. The timeline is empty when no phase was stored and also when the operation has no result: both say "nothing
     * was noted".
     */
    ExecutionTimeline timelineOf(OperationId operationId);
}
