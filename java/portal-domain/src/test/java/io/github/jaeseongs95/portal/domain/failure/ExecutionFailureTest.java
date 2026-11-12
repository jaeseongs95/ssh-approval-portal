package io.github.jaeseongs95.portal.domain.failure;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.running;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.contract.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CaptureState;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.ExecutionReason;
import io.github.jaeseongs95.portal.domain.operation.ExitStatus;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.OutputState;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.ResultFlag;
import io.github.jaeseongs95.portal.domain.operation.SignalDelivery;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.StreamCapture;
import io.github.jaeseongs95.portal.domain.operation.TimeoutMs;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class ExecutionFailureTest {

    /** The combinations 2.x produces (case A-759, and the call sites of executionFailure): the connection steps, the output steps, the artifact quota and the generic failure. */
    private static List<ExecutionFailure> producedByTwoX() {
        return List.of(
            new ExecutionFailure.Classified(ExecutionStage.SSH_CONNECT, ExecutionErrorCode.SSH_CONNECT_FAILED, RemoteOutcome.NOT_STARTED),
            new ExecutionFailure.Classified(ExecutionStage.SSH_CHANNEL, ExecutionErrorCode.SSH_CHANNEL_OPEN_FAILED, RemoteOutcome.NOT_STARTED),
            new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION, ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN),
            new ExecutionFailure.Classified(ExecutionStage.OUTPUT_RESERVATION, ExecutionErrorCode.OUTPUT_CAPACITY, RemoteOutcome.NOT_STARTED),
            new ExecutionFailure.Classified(ExecutionStage.OUTPUT_CAPTURE, ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, RemoteOutcome.UNKNOWN),
            new ExecutionFailure.Classified(ExecutionStage.OUTPUT_CAPTURE, ExecutionErrorCode.OUTPUT_CAPTURE_FAILED, RemoteOutcome.COMPLETED),
            new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.UNKNOWN),
            new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.ARTIFACT_QUOTA, RemoteOutcome.NOT_STARTED));
    }

    @Test
    @DisplayName("RC-A-759 the six allowed causes keep their stage, code and remote outcome, and the unclassified fallback is operation, OPERATION_FAILED, unknown")
    void sixCausesAndTheFallback() {
        for (ExecutionFailure failure : producedByTwoX()) {
            assertThat(failure.stage().accepts(failure.code())).isTrue();
        }
        ExecutionFailure fallback = new ExecutionFailure.Unclassified();
        assertThat(fallback.stage()).isEqualTo(ExecutionStage.OPERATION);
        assertThat(fallback.code()).isEqualTo(ExecutionErrorCode.OPERATION_FAILED);
        assertThat(fallback.remoteOutcome()).isEqualTo(RemoteOutcome.UNKNOWN);
    }

    @Test
    @DisplayName("RC-A-760 RC-A-761 S2-FA-01 a diagnosis cannot be forged: a code that does not belong to the stage is refused, and the type has the three fields and no text")
    void onlyAllowedFieldsAndPairs() {
        for (ExecutionStage stage : ExecutionStage.values()) {
            for (ExecutionErrorCode code : ExecutionErrorCode.values()) {
                if (!stage.accepts(code)) {
                    assertThatThrownBy(() -> new ExecutionFailure.Classified(stage, code, RemoteOutcome.UNKNOWN)).as("%s at %s", code, stage)
                        .isInstanceOf(IllegalArgumentException.class);
                }
            }
        }
        assertThat(Arrays.stream(ExecutionFailure.Classified.class.getRecordComponents()).map(RecordComponent::getName)).containsExactly("stage", "code", "remoteOutcome");
        assertThat(ExecutionFailure.Unclassified.class.getRecordComponents()).isEmpty();
        assertThatThrownBy(() -> new ExecutionFailure.Classified(null, ExecutionErrorCode.OPERATION_FAILED, RemoteOutcome.UNKNOWN)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-762 each tagged cause survives the settlement and the store: not started is failed and certain, any other is unknown and to be reconciled, executed once")
    void causesSurviveSettlementAndStore() {
        for (ExecutionFailure failure : producedByTwoX()) {
            boolean notStarted = failure.remoteOutcome() == RemoteOutcome.NOT_STARTED;
            ExecutionOutcome outcome = notStarted ? notStartedOutcome(failure) : ExecutionOutcome.transportLost(failure, List.of("Operation failed; do not replay automatically."));
            Operation settled = running().settle(outcome, T0.plusSeconds(5));
            assertThat(settled.state()).as("%s", failure).isEqualTo(notStarted ? OperationState.FAILED : OperationState.UNKNOWN);
            assertThat(settled.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, state -> {
                assertThat(state.certainty()).isEqualTo(notStarted ? OutcomeCertainty.NOT_DISPATCHED : OutcomeCertainty.UNKNOWN);
                assertThat(state.reconciliation()).isEqualTo(notStarted ? Reconciliation.NOT_REQUIRED : Reconciliation.REQUIRED);
                assertThat(state.result()).isInstanceOfSatisfying(RecordedResult.Executed.class, executed -> {
                    assertThat(executed.outcome().failure()).isEqualTo(failure);
                    assertThat(executed.outcome().failed()).isEqualTo(ResultFlag.FAILED);
                });
            });
            assertThat(Operation.restore(settled.snapshot()).settlement()).as("restored from the store").isEqualTo(settled.settlement());
        }
    }

    @Test
    @DisplayName("RC-A-763 an execution rejected for an unknown reason keeps the fixed fallback diagnosis and is unknown")
    void unknownRejectionKeepsTheFallback() {
        Operation unknown = running().settle(ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of("Operation failed; do not replay automatically.")),
            T0.plusSeconds(5));
        assertThat(unknown.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(unknown.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, state -> {
            assertThat(state.reconciliation()).isEqualTo(Reconciliation.REQUIRED);
            assertThat(state.result()).isInstanceOfSatisfying(RecordedResult.Executed.class, executed -> {
                assertThat(executed.outcome().failure()).isEqualTo(new ExecutionFailure.Unclassified());
                assertThat(executed.outcome().cleanup()).isEqualTo(CleanupState.INCOMPLETE);
                assertThat(executed.outcome().reason()).isEqualTo(ExecutionReason.TRANSPORT_LOST);
                assertThat(executed.outcome().texts()).containsExactly("Operation failed; do not replay automatically.");
            });
        });
    }

    @Test
    @DisplayName("S2-CO-04 the wire values of stages, remote outcomes, reasons and remote states are those of 2.x")
    void wireValues() throws Exception {
        assertThat(Arrays.stream(ExecutionStage.values()).map(ExecutionStage::wire)).containsExactly("ssh_connect", "ssh_channel", "ssh_execution", "output_reservation",
            "output_capture", "operation");
        assertThat(Arrays.stream(RemoteOutcome.values()).map(RemoteOutcome::wire)).containsExactly("not_started", "unknown", "completed");
        assertThat(Arrays.stream(ExecutionReason.values()).map(ExecutionReason::wire)).containsExactly("exit", "deadline", "cancel", "transport_lost", "channel_open_failed",
            "input_failed");
        assertThat(Arrays.stream(RemoteState.values()).map(RemoteState::wire)).containsExactly("not_dispatched", "exited", "unknown");
        JsonMapper mapper = new JsonMapper();
        assertThat(mapper.writeValueAsString(RemoteOutcome.NOT_STARTED)).isEqualTo("\"not_started\"");
        assertThat(mapper.writeValueAsString(ExecutionStage.OUTPUT_RESERVATION)).isEqualTo("\"output_reservation\"");
        assertThat(mapper.writeValueAsString(ExecutionReason.CHANNEL_OPEN_FAILED)).isEqualTo("\"channel_open_failed\"");
        assertThat(mapper.writeValueAsString(RemoteState.NOT_DISPATCHED)).isEqualTo("\"not_dispatched\"");
    }

    private static ExecutionOutcome notStartedOutcome(ExecutionFailure failure) {
        return new ExecutionOutcome(ExecutionReason.INPUT_FAILED, RemoteState.NOT_DISPATCHED, new ExitStatus.NoExit(), SignalDelivery.NOT_SENT, CleanupState.COMPLETE,
            Reconciliation.NOT_REQUIRED, OutputState.NOT_REPORTED, CaptureState.NOT_REPORTED, new TimeoutMs.None(), new StreamCapture.NotCaptured(),
            new StreamCapture.NotCaptured(), failure, ResultFlag.FAILED, List.of("Execution was refused before dispatch."), new CompletionEvidence.NoEvidence());
    }
}
