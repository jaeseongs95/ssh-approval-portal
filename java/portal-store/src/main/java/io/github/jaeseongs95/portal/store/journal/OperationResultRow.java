package io.github.jaeseongs95.portal.store.journal;

import java.time.Instant;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.ResultFlag;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.Truncation;

/**
 * Table {@code operation_result}: how an operation ended, either as an executed outcome ({@code resultKind EXECUTED}) or as a refusal before dispatch
 * ({@code REFUSED}). The columns that do not apply to the kind are NULL; the table's CHECK constraints keep the two shapes apart. {@code resultTexts} is the long-text
 * column of the vendor script V1_1 and holds a JSON array written by the mapper with the Boot {@code JsonMapper}.
 */
@Table("operation_result")
public record OperationResultRow(@Id String operationId, ResultKind resultKind, ResultFlag resultFlag, ExecutionReason execReason, RemoteState remoteState, ExitKind exitKind,
                                 Integer exitCode, String exitSignal, SignalDelivery signalDelivery, Long timeoutMs, CleanupState cleanup, Reconciliation execReconciliation,
                                 OutputState outputState, CaptureState capture, Long stdoutReceivedBytes, Long stdoutRetainedBytes, Long stdoutCursor,
                                 Truncation stdoutTruncated, Long stderrReceivedBytes, Long stderrRetainedBytes, Long stderrCursor, Truncation stderrTruncated,
                                 FailureKind failureKind, ExecutionStage failureStage, ExecutionErrorCode failureCode, RemoteOutcome failureRemoteOutcome,
                                 DispatchKind dispatchKind, DispatchReason dispatchReason, DispatchStage dispatchStage, EvidenceKind evidenceKind, Integer evidenceExitCode,
                                 Instant evidenceConfirmedAt, String evidenceSha256, EvidenceRead evidenceRead, String resultTexts, Instant execConnectedAt,
                                 Instant execDispatchedAt, Instant execClosedAt) {

    /**
     * The row with the three instants of the execution timeline (V7: connected, request sent, channel closed); {@code null} where the step was not reached. The
     * timeline belongs to the execution, not to the outcome, so it is written after the outcome and is kept when the same outcome is stored again.
     */
    public OperationResultRow withTimeline(Instant connectedAt, Instant dispatchedAt, Instant closedAt) {
        return new OperationResultRow(operationId, resultKind, resultFlag, execReason, remoteState, exitKind, exitCode, exitSignal, signalDelivery, timeoutMs, cleanup,
            execReconciliation, outputState, capture, stdoutReceivedBytes, stdoutRetainedBytes, stdoutCursor, stdoutTruncated, stderrReceivedBytes, stderrRetainedBytes,
            stderrCursor, stderrTruncated, failureKind, failureStage, failureCode, failureRemoteOutcome, dispatchKind, dispatchReason, dispatchStage, evidenceKind,
            evidenceExitCode, evidenceConfirmedAt, evidenceSha256, evidenceRead, resultTexts, connectedAt, dispatchedAt, closedAt);
    }

    /** Which shape the row has. */
    public enum ResultKind {
        EXECUTED, REFUSED
    }

    /** The variant of the exit status. */
    public enum ExitKind {
        EXITED, SIGNALED, NO_EXIT
    }

    /** The variant of the execution failure; {@code NONE} for a refused operation. */
    public enum FailureKind {
        NONE, CLASSIFIED, UNCLASSIFIED
    }

    /** The variant of the dispatch failure of a refused operation. */
    public enum DispatchKind {
        REFUSED, STEP_FAILED, UNCLASSIFIED
    }

    /** The variant of the completion evidence. */
    public enum EvidenceKind {
        NO_EVIDENCE, COMMAND_EXITED, FILE_PUBLISHED, FILE_READ
    }

    /** Whether the file that was read back was verified. */
    public enum EvidenceRead {
        VERIFIED, UNVERIFIED
    }
}
