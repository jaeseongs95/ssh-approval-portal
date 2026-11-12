package io.github.jaeseongs95.portal.domain.contract;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.failure.DispatchFailure;
import io.github.jaeseongs95.portal.domain.failure.ExecutionFailure;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** S2-FA-02 (stage 2 design 4.8, 5.5): the three variants of {@link PortalException} and what an error code implies when a throw site says nothing. */
class PortalExceptionTest {

    private static final Set<ErrorCode> RETRYABLE = Set.of(OperationErrorCode.OPERATION_QUEUE_FULL, OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY,
        CapacityErrorCode.REQUEST_QUEUE_FULL, RequestErrorCode.MAINTENANCE_ACTIVE, ArtifactErrorCode.ARTIFACT_MAINTENANCE, CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED);

    @Test
    @DisplayName("S2-FA-02 a code is retryable by default exactly for the full queues and the maintenance windows")
    void retryableByDefaultOnlyForFullQueuesAndMaintenance() {
        for (ErrorCode code : allCodes()) {
            RequestRefusedException refusal = new RequestRefusedException(code);
            assertThat(refusal.retryable()).as(code.name()).isEqualTo(RETRYABLE.contains(code));
            assertThat(code.retryableByDefault()).as(code.name()).isEqualTo(RETRYABLE.contains(code));
        }
    }

    @Test
    @DisplayName("S2-FA-02 a refusal before admission was not attempted; desktop, transfer, execution and store failures are unknown")
    void attemptDefaultsFollowTheCategory() {
        for (ErrorCode code : allCodes()) {
            ExecutionAttempt expected = switch (code) {
                case RequestErrorCode request -> request == RequestErrorCode.READ_COMMAND_EXECUTION_UNKNOWN ? ExecutionAttempt.ATTEMPTED
                    : request == RequestErrorCode.OPERATION_ACCEPTANCE_NOT_CONFIRMED ? ExecutionAttempt.UNKNOWN : ExecutionAttempt.NOT_ATTEMPTED;
                case ArtifactErrorCode artifact -> ExecutionAttempt.NOT_ATTEMPTED;
                case HistoryErrorCode history -> ExecutionAttempt.NOT_ATTEMPTED;
                case CapacityErrorCode capacity -> ExecutionAttempt.NOT_ATTEMPTED;
                case OperationErrorCode operation -> Set.of(OperationErrorCode.OPERATION_STORE_FAILED, OperationErrorCode.OPERATION_OUTCOME_PERSISTENCE_FAILED,
                    OperationErrorCode.OPERATION_DISPATCH_PERSISTENCE_FAILED, OperationErrorCode.OPERATION_NOTIFICATION_FAILED, OperationErrorCode.OPERATION_OBSERVER_ABORTED,
                    OperationErrorCode.OPERATION_CONTRACT_IMMUTABLE, OperationErrorCode.OPERATION_VERSION_CONFLICT, OperationErrorCode.INVALID_OPERATION_TRANSITION,
                    OperationErrorCode.INVALID_OPERATION_RECORD).contains(operation) ? ExecutionAttempt.UNKNOWN : ExecutionAttempt.NOT_ATTEMPTED;
                case DesktopErrorCode desktop -> ExecutionAttempt.UNKNOWN;
                case TransferErrorCode transfer -> ExecutionAttempt.UNKNOWN;
                case ExecutionErrorCode execution -> ExecutionAttempt.UNKNOWN;
            };
            assertThat(new RequestRefusedException(code).attempt()).as(code.name()).isEqualTo(expected);
        }
    }

    @Test
    @DisplayName("S2-FA-02 a throw site that knows better states retryable and attempt itself")
    void aThrowSiteOverridesTheDefaults() {
        RequestRefusedException refusal = new RequestRefusedException(RequestErrorCode.MAINTENANCE_ACTIVE, false, ExecutionAttempt.UNKNOWN);
        assertThat(refusal.retryable()).isFalse();
        assertThat(refusal.attempt()).isEqualTo(ExecutionAttempt.UNKNOWN);
        assertThat(refusal.code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE);
    }

    @Test
    @DisplayName("S2-FA-02 the public error object carries the code, retryable and the attempt of the refusal")
    void errorDataCarriesTheRefusal() {
        ErrorData data = ErrorData.of(new RequestRefusedException(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED));
        assertThat(data.code()).isEqualTo(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED);
        assertThat(data.retryable()).isTrue();
        assertThat(data.executionAttempted()).isEqualTo(ExecutionAttempt.NOT_ATTEMPTED);
    }

    @Test
    @DisplayName("S2-FA-02 executionAttempted is false, true or the text unknown on the wire")
    void attemptWireValues() {
        assertThat(ExecutionAttempt.NOT_ATTEMPTED.wire()).isEqualTo(Boolean.FALSE);
        assertThat(ExecutionAttempt.ATTEMPTED.wire()).isEqualTo(Boolean.TRUE);
        assertThat(ExecutionAttempt.UNKNOWN.wire()).isEqualTo("unknown");
    }

    @Test
    @DisplayName("S2-FA-02 a message is a fixed sentence: text of the cause never becomes part of it")
    void messagesAreFixedAndTheCauseIsKept() {
        RuntimeException cause = new RuntimeException("password=hunter2 from the remote host");
        List<PortalException> exceptions = List.of(new RequestRefusedException(RequestErrorCode.TARGET_UNAVAILABLE, cause),
            new DispatchRefusedException(new DispatchFailure.Unclassified(), cause), new ExecutionFailedException(new ExecutionFailure.Unclassified(), cause));
        for (PortalException exception : exceptions) {
            assertThat(exception.getMessage()).doesNotContain("hunter2");
            assertThat(exception.getCause()).isSameAs(cause);
        }
        assertThat(exceptions.get(0).getMessage()).isEqualTo("Request refused: TARGET_UNAVAILABLE");
    }

    @Test
    @DisplayName("S2-FA-02 the three variants are the whole hierarchy, and each carries its diagnostic")
    void threeVariants() {
        DispatchFailure dispatch = new DispatchFailure.Unclassified();
        ExecutionFailure execution = new ExecutionFailure.Unclassified();
        List<PortalException> variants = List.of(new RequestRefusedException(RequestErrorCode.REQUEST_REFUSED), new DispatchRefusedException(dispatch),
            new ExecutionFailedException(execution));
        List<String> seen = new ArrayList<>();
        for (PortalException exception : variants) {
            seen.add(switch (exception) {
                case RequestRefusedException request -> "request:" + request.code().name();
                case DispatchRefusedException refused -> "dispatch:" + (refused.failure() == dispatch);
                case ExecutionFailedException failed -> "execution:" + (failed.failure() == execution);
            });
        }
        assertThat(seen).containsExactly("request:REQUEST_REFUSED", "dispatch:true", "execution:true");
    }

    @Test
    @DisplayName("S2-FA-02 a refusal needs a code, and a diagnostic exception needs its failure")
    void nullArgumentsAreProgrammingErrors() {
        assertThatThrownBy(() -> new RequestRefusedException(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new DispatchRefusedException(null)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new ExecutionFailedException(null)).isInstanceOf(NullPointerException.class);
    }

    private List<ErrorCode> allCodes() {
        List<ErrorCode> codes = new ArrayList<>();
        Collections.addAll(codes, RequestErrorCode.values());
        Collections.addAll(codes, OperationErrorCode.values());
        Collections.addAll(codes, ArtifactErrorCode.values());
        Collections.addAll(codes, HistoryErrorCode.values());
        Collections.addAll(codes, CapacityErrorCode.values());
        Collections.addAll(codes, DesktopErrorCode.values());
        Collections.addAll(codes, TransferErrorCode.values());
        Collections.addAll(codes, ExecutionErrorCode.values());
        return codes;
    }
}
