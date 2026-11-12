package io.github.jaeseongs95.portal.app.remote;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;

/**
 * What {@link RemoteExecutor#run} answers: the settled outcome the domain decides the operation's state from, and the time of each phase. The outcome is the
 * domain's own {@link ExecutionOutcome}, so the decision table stays in one place ({@code Operation#settle}); the adapter does not make a second result shape.
 *
 * @param outcome how the execution ended
 * @param timeline the phases it reached and when
 */
public record ExecutionReport(ExecutionOutcome outcome, ExecutionTimeline timeline) {

    public ExecutionReport {
        Objects.requireNonNull(outcome, "outcome");
        Objects.requireNonNull(timeline, "timeline");
    }
}
