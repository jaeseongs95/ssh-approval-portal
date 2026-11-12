package io.github.jaeseongs95.portal.app.operation;

import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.event.ChangeWaiters;
import io.github.jaeseongs95.portal.app.event.WaitResult;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;

/**
 * Looking at an operation and cancelling it (2.x {@code operations.mjs}, cases B-234, B-240 to B-242, B-193, B-194). Both re-check the target revision: an operation is
 * bound to the revision it was approved for, and a target that changed since is {@code TARGET_REVISION_CONFLICT}, before and after a wait.
 */
@Service
public class OperationsService {

    private final OperationJournal journal;
    private final CurrentTargets targets;
    private final ChangeWaiters waiters;
    private final RunningExecutions running;
    private final OperationWrites writes;
    private final OutcomeAudit outcomes;
    private final Clock clock;

    public OperationsService(OperationJournal journal, CurrentTargets targets, ChangeWaiters waiters, RunningExecutions running, OperationWrites writes,
                             OutcomeAudit outcomes, Clock clock) {
        this.journal = journal;
        this.targets = targets;
        this.waiters = waiters;
        this.running = running;
        this.writes = writes;
        this.outcomes = outcomes;
        this.clock = clock;
    }

    /**
     * The operation, after it waited up to {@code wait} for a change (no wait at all for a zero wait or a terminal operation). A running operation is returned as it
     * is, never waited for to its end by default (B-242). A caller that stops waiting ({@code cancel}) ends only its wait: the operation is not cancelled (B-193).
     */
    public CompletionStage<Observation> observe(OperationId id, Duration wait, CancelToken cancel) {
        Operation first = require(id);
        targets.requireAt(first.targetId(), first.targetRevision());
        boolean waits = !wait.isZero() && !wait.isNegative() && !first.state().isTerminal();
        if (!waits) {
            return CompletableFuture.completedStage(new Observation(first, false));
        }
        long seen = first.version();
        CompletableFuture<WaitResult> pending = waiters.await(id, seen, wait, cancel);
        Operation again = require(id);
        if (again.version() != seen) {
            pending.cancel(false);
            return CompletableFuture.completedStage(observed(again, seen));
        }
        return pending.thenApply(result -> observed(require(id), seen));
    }

    /**
     * Cancels the operation itself (no replacement is submitted, B-241): before dispatch it is cancelled at once, while it runs it becomes {@code TERMINATING} and the
     * running execution is asked to stop; the stop is not confirmed until the executor settles (B-194). An operation that already ended is returned unchanged.
     */
    public Operation cancel(OperationId id) {
        Operation operation = require(id);
        targets.requireAt(operation.targetId(), operation.targetRevision());
        Operation next = operation.requestCancel(clock.instant());
        if (next.version() == operation.version()) {
            return operation;
        }
        Operation stored = writes.store(next, operation.version());
        if (stored.state() == OperationState.TERMINATING) {
            running.cancel(id);
        } else if (stored.state().isTerminal()) {
            outcomes.recordOutcome(stored);
        }
        return stored;
    }

    private Observation observed(Operation operation, long seen) {
        targets.requireAt(operation.targetId(), operation.targetRevision());
        return new Observation(operation, operation.version() == seen && !operation.state().isTerminal());
    }

    private Operation require(OperationId id) {
        return journal.find(id).orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
    }
}
