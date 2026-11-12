package io.github.jaeseongs95.portal.domain.approval;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.queued;
import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class MaintenancePolicyTest {

    private final MaintenancePolicy policy = new MaintenancePolicy();

    @Test
    @DisplayName("RC-B-065 the bridge is reserved only when it is quiet: no request is pending, evaluating, queued or running, and no reservation exists")
    void reservationNeedsAQuietBridge() {
        assertThat(policy.canReserve(new MaintenanceState.Open(), StateCounts.none())).isEqualTo(new MaintenancePolicy.ReservationDecision.Allowed());
        assertThat(policy.canReserve(new MaintenanceState.Open(), new StateCounts(Map.of(OperationState.COMPLETED, 40, OperationState.UNKNOWN, 3))))
            .as("history does not block maintenance").isEqualTo(new MaintenancePolicy.ReservationDecision.Allowed());
        for (OperationState busy : new OperationState[] {OperationState.ACCEPTED, OperationState.PENDING, OperationState.EVALUATING, OperationState.QUEUED, OperationState.STARTING,
            OperationState.RUNNING, OperationState.TERMINATING}) {
            assertThat(policy.canReserve(new MaintenanceState.Open(), new StateCounts(Map.of(busy, 1)))).as("with one %s", busy)
                .isEqualTo(new MaintenancePolicy.ReservationDecision.Refused(MaintenancePolicy.ReservationRefusal.REQUESTS_OPEN));
        }
        assertThat(policy.canReserve(new MaintenanceState.Reserved(), StateCounts.none()))
            .isEqualTo(new MaintenancePolicy.ReservationDecision.Refused(MaintenancePolicy.ReservationRefusal.ALREADY_RESERVED));
    }

    @Test
    @DisplayName("S2-ST-01 a queued operation that waits when maintenance begins is refused before dispatch for maintenance, and nothing ran")
    void queuedOperationIsClosed() {
        DispatchFailure failure = policy.failureForQueuedOperation();
        assertThat(failure).isEqualTo(DispatchFailure.refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE));
        Operation closed = queued().refuseBeforeDispatch(failure, T0.plusSeconds(3));
        assertThat(closed.state()).isEqualTo(OperationState.FAILED);
    }
}
