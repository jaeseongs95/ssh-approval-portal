package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.failure.ExecutionFailure;
import java.util.List;
import java.util.Objects;

/**
 * What an executor reports when an execution has ended: the input of {@link Operation#settle}. The value is settled by construction (2.x had a {@code phase}
 * field that was always {@code settled}); every field is checked when the outcome is built, and nothing is validated again when it is shown.
 *
 * <p>{@link #verdict()} is the decision table of 2.x operation-store.mjs:261-269, first match wins:
 * <ol>
 *   <li>the cleanup is incomplete: {@code UNKNOWN};
 *   <li>the remote state is unknown, or reconciliation is required: {@code UNKNOWN};
 *   <li>the reason is a cancel: {@code CANCELLED};
 *   <li>the executor says failed, or the process did not exit, or it exited for another reason, or its exit was not clean: {@code FAILED};
 *   <li>otherwise {@code COMPLETED}, but only with {@link CompletionEvidence} that confirms it; without it the result is {@code UNKNOWN} (defect D-0035).
 * </ol>
 *
 * @param reason why the execution ended
 * @param remoteState what is known of the remote process
 * @param exit how the process ended
 * @param signalDelivery whether a cancel signal was passed on
 * @param cleanup whether everything the execution opened is closed
 * @param reconciliation whether the owner has to compare the target with the record
 * @param outputState whether the captured output is whole
 * @param capture whether capturing the output worked
 * @param timeout the time limit that ended the execution, if one did
 * @param stdout what was captured of the standard output
 * @param stderr what was captured of the standard error
 * @param failure the diagnosis of a failure
 * @param failed the executor's own verdict
 * @param texts fixed sentences for the owner; never raw error text
 * @param evidence what proves a completion
 */
public record ExecutionOutcome(ExecutionReason reason, RemoteState remoteState, ExitStatus exit, SignalDelivery signalDelivery, CleanupState cleanup,
                               Reconciliation reconciliation, OutputState outputState, CaptureState capture, TimeoutMs timeout, StreamCapture stdout,
                               StreamCapture stderr, ExecutionFailure failure, ResultFlag failed, List<String> texts, CompletionEvidence evidence) {

    public ExecutionOutcome {
        Objects.requireNonNull(reason, "reason");
        Objects.requireNonNull(remoteState, "remoteState");
        Objects.requireNonNull(exit, "exit");
        Objects.requireNonNull(signalDelivery, "signalDelivery");
        Objects.requireNonNull(cleanup, "cleanup");
        Objects.requireNonNull(reconciliation, "reconciliation");
        Objects.requireNonNull(outputState, "outputState");
        Objects.requireNonNull(capture, "capture");
        Objects.requireNonNull(timeout, "timeout");
        Objects.requireNonNull(stdout, "stdout");
        Objects.requireNonNull(stderr, "stderr");
        Objects.requireNonNull(failure, "failure");
        Objects.requireNonNull(failed, "failed");
        texts = List.copyOf(texts);
        Objects.requireNonNull(evidence, "evidence");
        if (evidence instanceof CompletionEvidence.CommandExited exited && exit instanceof ExitStatus.Exited status && exited.exitCode() != status.code()) {
            throw new IllegalArgumentException("The exit evidence and the exit status name different codes");
        }
    }

    /**
     * An execution that ended without a process: the command never started (a cancel before the effect, an input that failed). Settled, cleaned up, and certain
     * that nothing ran on the target.
     */
    public static ExecutionOutcome notDispatched(ExecutionReason reason, List<String> texts) {
        return new ExecutionOutcome(reason, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.COMPLETE, Reconciliation.NOT_REQUIRED,
            OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
            new ExecutionFailure.Unclassified(), ResultFlag.FAILED, texts, new CompletionEvidence.NoEvidence());
    }

    /**
     * An execution that lost its transport after the effect may have started: the remote state is unknown, the cleanup is not confirmed and the owner has to
     * reconcile. Nothing here may be replayed automatically.
     */
    public static ExecutionOutcome transportLost(ExecutionFailure failure, List<String> texts) {
        return new ExecutionOutcome(ExecutionReason.TRANSPORT_LOST, RemoteState.UNKNOWN, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.INCOMPLETE,
            Reconciliation.REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), failure, ResultFlag.FAILED, texts, new CompletionEvidence.NoEvidence());
    }

    /** A command that ran and exited with the code; the exit is the evidence. */
    public static ExecutionOutcome exited(int exitCode, List<String> texts) {
        return new ExecutionOutcome(ExecutionReason.EXIT, RemoteState.EXITED, new ExitStatus.Exited(exitCode), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.COMPLETE, CaptureState.OK, new TimeoutMs.None(), new StreamCapture.NotCaptured(), new StreamCapture.NotCaptured(),
            new ExecutionFailure.Unclassified(), exitCode == 0 ? ResultFlag.OK : ResultFlag.FAILED, texts, new CompletionEvidence.CommandExited(exitCode));
    }

    /** The state the operation moves to when this outcome settles it. */
    public OperationState verdict() {
        if (cleanup != CleanupState.COMPLETE) {
            return OperationState.UNKNOWN;
        }
        if (remoteState == RemoteState.UNKNOWN || reconciliation == Reconciliation.REQUIRED) {
            return OperationState.UNKNOWN;
        }
        if (reason == ExecutionReason.CANCEL) {
            return OperationState.CANCELLED;
        }
        if (failed == ResultFlag.FAILED || remoteState != RemoteState.EXITED || reason != ExecutionReason.EXIT || !isCleanExit()) {
            return OperationState.FAILED;
        }
        return evidence.confirmsCompletion() ? OperationState.COMPLETED : OperationState.UNKNOWN;
    }

    private boolean isCleanExit() {
        return switch (exit) {
            case ExitStatus.Exited exited -> exited.code() == 0;
            case ExitStatus.Signaled signaled -> false;
            case ExitStatus.NoExit noExit -> true;
        };
    }
}
