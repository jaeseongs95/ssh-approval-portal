package io.github.jaeseongs95.portal.app.admission;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.EnumSet;
import java.util.Set;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.domain.approval.AdmissionDecision;
import io.github.jaeseongs95.portal.domain.approval.CapacityKind;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.schedule.SaturationReason;

/** The queue refusals are five different answers, and none of them is a connection failure (defect D-0038; S3-SS-03, S3-UC-01). */
class AdmissionGateTest {

    private final AdmissionGate gate = new AdmissionGate();

    private RequestRefusedException refusal(AdmissionDecision decision) {
        return (RequestRefusedException) catchThrowable(decision);
    }

    private Throwable catchThrowable(AdmissionDecision decision) {
        try {
            gate.require(decision);
        } catch (RequestRefusedException e) {
            return e;
        }
        throw new AssertionError("The decision was not refused");
    }

    @Test
    @DisplayName("S3-SS-03 an admitted request passes, and every refusal is given before anything was sent to a target")
    void admittedPassesRefusedStopsBeforeTheTarget() {
        assertThatCode(() -> gate.require(new AdmissionDecision.Admit())).doesNotThrowAnyException();
        for (CapacityKind kind : CapacityKind.values()) {
            RequestRefusedException refused = refusal(new AdmissionDecision.RejectedCapacity(kind));
            assertThat(refused.code()).isEqualTo(kind.errorCode());
            assertThat(refused.attempt()).isEqualTo(ExecutionAttempt.NOT_ATTEMPTED);
        }
        assertThat(refusal(new AdmissionDecision.RejectedMaintenance()).code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE);
    }

    @Test
    @DisplayName("S3-SS-03 RC-B-381 a full request store, a full execution queue and an exhausted reconciliation budget have three different codes; a full queue may be retried")
    void threeLimitsThreeCodes() {
        ErrorCode store = refusal(new AdmissionDecision.RejectedCapacity(CapacityKind.REQUEST_STORE)).code();
        ErrorCode queue = refusal(new AdmissionDecision.RejectedCapacity(CapacityKind.EXECUTION_QUEUE)).code();
        ErrorCode budget = refusal(new AdmissionDecision.RejectedCapacity(CapacityKind.RECONCILIATION)).code();
        assertThat(Set.of(store, queue, budget)).hasSize(3);
        assertThat(store).isEqualTo(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED);
        assertThat(queue).isEqualTo(OperationErrorCode.OPERATION_QUEUE_FULL);
        assertThat(refusal(new AdmissionDecision.RejectedCapacity(CapacityKind.EXECUTION_QUEUE)).retryable()).isTrue();
        assertThat(Set.of(store, queue, budget)).doesNotContain(ExecutionErrorCode.SSH_CONNECT_FAILED);
    }

    @Test
    @DisplayName("S3-SS-03 a saturated queue is never an SSH failure: every reason has a queue code, and the unknown budget keeps its own")
    void saturationIsNotAConnectionFailure() {
        Set<ErrorCode> codes = EnumSet.allOf(SaturationReason.class).stream().map(gate::codeFor).collect(java.util.stream.Collectors.toSet());
        assertThat(codes).containsExactlyInAnyOrder(CapacityErrorCode.EXECUTION_QUEUE_FULL, OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY);
        assertThat(gate.codeFor(SaturationReason.GLOBAL_CONCURRENCY)).isEqualTo(CapacityErrorCode.EXECUTION_QUEUE_FULL);
        assertThat(gate.codeFor(SaturationReason.UNKNOWN_BUDGET)).isEqualTo(OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY);
        assertThatThrownBy(() -> gate.require(new AdmissionDecision.RejectedMaintenance())).isInstanceOf(RequestRefusedException.class);
    }
}
