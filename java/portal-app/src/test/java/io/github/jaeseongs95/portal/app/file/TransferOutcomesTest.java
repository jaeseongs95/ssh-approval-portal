package io.github.jaeseongs95.portal.app.file;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ReservedSplit;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;

/** The mapping of a transfer's answer to the outcome an operation settles from, without any I/O (defects D-0012, D-0013, D-0035; decisions D3-03, D3-17). */
class TransferOutcomesTest {

    private static final Duration DEADLINE = Duration.ofSeconds(120);

    private final TransferOutcomes outcomes = new TransferOutcomes();

    @Test
    @DisplayName("S3-AR-02 / S3-AR-03 / D-0012: the three reservation refusals are three codes with their own numbers, at stage OPERATION and NOT_STARTED, FAILED and never unknown")
    void eachReservationRefusalHasItsOwnCodeAndNumbers() {
        ExecutionOutcome budget = outcomes.reservationRefused(ArtifactRefusal.of(new ArtifactReservation.BudgetExceeded(1090, new ReservedSplit(6000, 3500), 10_000)));
        ExecutionOutcome disk = outcomes.reservationRefused(ArtifactRefusal.of(new ArtifactReservation.DiskSpaceInsufficient(1090, 1500, 1000)));
        ExecutionOutcome size = outcomes.reservationRefused(ArtifactRefusal.of(new ArtifactReservation.FileTooLarge(20_000, 10_000)));

        assertThat(budget.failure()).isEqualTo(new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.ARTIFACT_QUOTA, RemoteOutcome.NOT_STARTED));
        assertThat(budget.texts().get(0)).contains("requestedBytes=1090", "liveBytes=6000", "holdingBytes=3500", "budgetBytes=10000");
        assertThat(disk.failure()).isEqualTo(new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.ARTIFACT_STORAGE_FULL, RemoteOutcome.NOT_STARTED));
        assertThat(disk.texts().get(0)).contains("requestedBytes=1090", "usableBytes=1500", "marginBytes=1000");
        assertThat(size.failure()).isEqualTo(new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.NOT_STARTED));
        assertThat(size.texts().get(0)).startsWith("FILE_TOO_LARGE").contains("limitBytes=10000");
        for (ExecutionOutcome outcome : new ExecutionOutcome[] {budget, disk, size}) {
            assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
            assertThat(outcome.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        }
        assertThat(ArtifactRefusal.of(new ArtifactReservation.BudgetExceeded(1, new ReservedSplit(0, 0), 1)).code()).isEqualTo(ExecutionErrorCode.ARTIFACT_QUOTA);
        assertThat(ArtifactRefusal.of(new ArtifactReservation.FileTooLarge(2, 1)).code()).isEqualTo(ArtifactErrorCode.FILE_TOO_LARGE);
    }

    @ParameterizedTest
    @EnumSource(TransferFailureCause.class)
    @DisplayName("S3-SF-09 / D3-17: a download that did not get to its effect is NOT_DISPATCHED, needs no reconciliation and is FAILED (or CANCELLED when the owner asked), whatever the cause")
    void aFailedReadLeavesNothingToReconcile(TransferFailureCause cause) {
        ExecutionOutcome outcome = outcomes.download(new DownloadResult.Failed(cause), DEADLINE);

        assertThat(outcome.remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(outcome.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED);
        assertThat(outcome.verdict()).isEqualTo(cause == TransferFailureCause.CANCELLED ? OperationState.CANCELLED : OperationState.FAILED);
        assertThat(outcome.evidence()).isInstanceOf(CompletionEvidence.NoEvidence.class);
    }

    @Test
    @DisplayName("S3-SF-08 / D-0013: a permission refusal of a read is a classified failure with its own code text and the SFTP status, not a lost transport")
    void aPermissionRefusalIsNotATransportFailure() {
        ExecutionOutcome denied = outcomes.download(new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3)), DEADLINE);
        ExecutionOutcome lost = outcomes.download(new DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST), DEADLINE);

        assertThat(denied.texts().get(0)).startsWith("PERMISSION_DENIED").contains("sftpStatus=3");
        assertThat(lost.texts().get(0)).startsWith("SSH_EXECUTION_FAILED");
        assertThat(denied.failure()).isNotEqualTo(lost.failure());
        assertThat(denied.verdict()).isEqualTo(OperationState.FAILED);
    }

    @Test
    @DisplayName("D-0035: a fetched file is no outcome by itself (the use case stores and verifies it first), and a completion carries the evidence or it is not a completion")
    void aCompletionNeedsItsEvidence() {
        assertThatThrownBy(() -> outcomes.download(new DownloadResult.Fetched(0, new io.github.jaeseongs95.portal.domain.id.Digest("a".repeat(64))), DEADLINE))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(outcomes.downloaded().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(outcomes.completed(new CompletionEvidence.NoEvidence(), "done").verdict()).as("an evidence that does not confirm gives UNKNOWN").isEqualTo(OperationState.UNKNOWN);
        assertThat(outcomes.completed(new CompletionEvidence.FileRead(false), "done").verdict()).isEqualTo(OperationState.UNKNOWN);
    }
}
