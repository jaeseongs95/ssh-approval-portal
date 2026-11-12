package io.github.jaeseongs95.portal.domain.error;

import static io.github.jaeseongs95.portal.domain.error.DispatchReason.AUDIT_FAILED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.AUTHORITY;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.BUSY;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.CLAIM_FAILED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.INVALID_COMMAND;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.MAINTENANCE;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.PERSISTENCE_FAILED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.PLAN_EXPIRED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.POLICY_CHANGED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.POLICY_DENIED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.PRIVATE_PLAN;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.QUEUE_FULL;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.REQUEST_STATE;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.TARGET_CHANGED;
import static io.github.jaeseongs95.portal.domain.error.DispatchReason.UNKNOWN;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.assertInvalidTransition;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.pending;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.running;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.starting;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class DispatchFailureTest {

    /** The pairs the call sites of 2.x dispatchRefusal and dispatchStep produce, by stage (approval-queue.mjs, command-automation.mjs, agent-cli.mjs, vendor.mjs). */
    private static Map<DispatchStage, Set<DispatchReason>> callSites() {
        Map<DispatchStage, Set<DispatchReason>> pairs = new EnumMap<>(DispatchStage.class);
        pairs.put(DispatchStage.UNKNOWN, EnumSet.of(UNKNOWN));
        pairs.put(DispatchStage.MAINTENANCE, EnumSet.of(MAINTENANCE));
        pairs.put(DispatchStage.REQUEST_STATE, EnumSet.of(REQUEST_STATE));
        pairs.put(DispatchStage.AUTHORITY, EnumSet.of(AUTHORITY));
        pairs.put(DispatchStage.COMMAND_VALIDATION, EnumSet.of(INVALID_COMMAND));
        pairs.put(DispatchStage.COMMAND_GUARD, EnumSet.of(UNKNOWN));
        pairs.put(DispatchStage.FILE_GUARD, EnumSet.of(UNKNOWN, AUTHORITY));
        pairs.put(DispatchStage.SOURCE_PLAN, EnumSet.of(PRIVATE_PLAN));
        pairs.put(DispatchStage.TARGET_GUARD, EnumSet.of(TARGET_CHANGED));
        pairs.put(DispatchStage.CLI_GUARD, EnumSet.of(UNKNOWN, PRIVATE_PLAN, PLAN_EXPIRED));
        pairs.put(DispatchStage.POLICY_GUARD, EnumSet.of(UNKNOWN, POLICY_CHANGED, POLICY_DENIED));
        pairs.put(DispatchStage.BUSY_CHECK, EnumSet.of(BUSY));
        pairs.put(DispatchStage.EXECUTION_QUEUE, EnumSet.of(QUEUE_FULL));
        pairs.put(DispatchStage.EXECUTION_CLAIM, EnumSet.of(CLAIM_FAILED));
        pairs.put(DispatchStage.DECISION_PERSISTENCE, EnumSet.of(PERSISTENCE_FAILED));
        pairs.put(DispatchStage.DECISION_AUDIT, EnumSet.of(AUDIT_FAILED));
        pairs.put(DispatchStage.EVALUATION_PERSISTENCE, EnumSet.of(PERSISTENCE_FAILED));
        pairs.put(DispatchStage.START_AUDIT, EnumSet.of(AUDIT_FAILED));
        pairs.put(DispatchStage.START_PERSISTENCE, EnumSet.of(PERSISTENCE_FAILED));
        return pairs;
    }

    @Test
    @DisplayName("S2-FA-01 of the 15 x 19 combinations exactly the 24 pairs 2.x produces are accepted, in both forms; every other is refused")
    void onlyTheKnownPairsAreAccepted() {
        int accepted = 0;
        for (DispatchStage stage : DispatchStage.values()) {
            for (DispatchReason reason : DispatchReason.values()) {
                boolean expected = callSites().get(stage).contains(reason);
                if (expected) {
                    accepted++;
                    assertThat(DispatchFailure.refused(reason, stage)).isEqualTo(new DispatchFailure.Refused(reason, stage));
                    assertThat(DispatchFailure.stepFailed(stage, reason)).isEqualTo(new DispatchFailure.StepFailed(stage, reason));
                } else {
                    assertThatThrownBy(() -> DispatchFailure.refused(reason, stage)).as("%s at %s", reason, stage).isInstanceOf(IllegalArgumentException.class);
                    assertThatThrownBy(() -> DispatchFailure.stepFailed(stage, reason)).isInstanceOf(IllegalArgumentException.class);
                }
            }
        }
        assertThat(accepted).isEqualTo(24);
        assertThat(new DispatchFailure.Unclassified().reason()).isEqualTo(UNKNOWN);
        assertThat(new DispatchFailure.Unclassified().stage()).isEqualTo(DispatchStage.UNKNOWN);
    }

    @Test
    @DisplayName("RC-A-625 S2-FA-01 a diagnosis is two enums and nothing else: no message, no cause, no property of an exception can be part of it")
    void aDiagnosisHoldsNoText() {
        for (Class<?> variant : List.of(DispatchFailure.Refused.class, DispatchFailure.StepFailed.class)) {
            assertThat(Arrays.stream(variant.getRecordComponents()).map(RecordComponent::getType)).containsExactlyInAnyOrder(DispatchReason.class, DispatchStage.class);
        }
        assertThat(DispatchFailure.Unclassified.class.getRecordComponents()).isEmpty();
    }

    @Test
    @DisplayName("RC-A-625 the five fixed diagnoses of the approval step keep their reason and stage, and the operation ends once as failed and not dispatched")
    void fixedDiagnosesEndTheOperationOnce() {
        List<DispatchFailure> failures = List.of(DispatchFailure.stepFailed(DispatchStage.START_PERSISTENCE, PERSISTENCE_FAILED),
            DispatchFailure.stepFailed(DispatchStage.START_PERSISTENCE, PERSISTENCE_FAILED), DispatchFailure.stepFailed(DispatchStage.START_AUDIT, AUDIT_FAILED),
            DispatchFailure.stepFailed(DispatchStage.COMMAND_GUARD, UNKNOWN), DispatchFailure.refused(MAINTENANCE, DispatchStage.MAINTENANCE));
        for (DispatchFailure failure : failures) {
            Operation failed = starting().refuseBeforeDispatch(failure, T0.plusSeconds(4));
            assertThat(failed.state()).isEqualTo(OperationState.FAILED);
            assertThat(failed.settlement()).isInstanceOfSatisfying(Settlement.Settled.class, settled -> {
                assertThat(settled.result()).isEqualTo(new RecordedResult.Refused(failure));
                assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED);
            });
            assertInvalidTransition(() -> failed.refuseBeforeDispatch(failure, T0.plusSeconds(5)));
            assertThat(Operation.restore(failed.snapshot()).settlement()).as("the diagnosis survives the store").isEqualTo(failed.settlement());
        }
    }

    @Test
    @DisplayName("RC-A-736 the guards of a source request are told apart by reason and step: private plan, target changed, policy changed, policy denied")
    void guardsAreToldApart() {
        List<DispatchFailure> guards = List.of(DispatchFailure.refused(PRIVATE_PLAN, DispatchStage.SOURCE_PLAN), DispatchFailure.refused(TARGET_CHANGED, DispatchStage.TARGET_GUARD),
            DispatchFailure.refused(POLICY_CHANGED, DispatchStage.POLICY_GUARD), DispatchFailure.refused(POLICY_DENIED, DispatchStage.POLICY_GUARD));
        assertThat(guards).hasSize(4).doesNotHaveDuplicates();
        assertThatThrownBy(() -> DispatchFailure.refused(POLICY_DENIED, DispatchStage.SOURCE_PLAN)).isInstanceOf(IllegalArgumentException.class);
        for (DispatchFailure guard : guards) {
            Operation refused = pending().refuseBeforeDispatch(guard, T0.plusSeconds(2));
            assertThat(refused.state()).isEqualTo(OperationState.FAILED);
        }
    }

    @Test
    @DisplayName("RC-A-737 RC-A-738 a failed save of the evaluation and a failed start audit are persistence and audit failures, not a busy executor or a lost transport")
    void persistenceAndAuditAreNotBusy() {
        DispatchFailure evaluation = DispatchFailure.stepFailed(DispatchStage.EVALUATION_PERSISTENCE, PERSISTENCE_FAILED);
        DispatchFailure audit = DispatchFailure.stepFailed(DispatchStage.START_AUDIT, AUDIT_FAILED);
        assertThat(evaluation.reason()).isNotEqualTo(BUSY).isNotEqualTo(QUEUE_FULL);
        assertThat(audit.reason()).isEqualTo(AUDIT_FAILED);
        assertThat(pending().refuseBeforeDispatch(evaluation, T0.plusSeconds(2)).state()).isEqualTo(OperationState.FAILED);
        Operation lost = running().settle(ExecutionOutcome.transportLost(new ExecutionFailure.Unclassified(), List.of()), T0.plusSeconds(5));
        assertThat(lost.state()).as("a lost transport after the effect is not a failure before dispatch").isEqualTo(OperationState.UNKNOWN);
    }

    @Test
    @DisplayName("S2-CO-04 the wire values of reasons and stages are the lowercase 15 and 19 values of 2.x")
    void wireValues() throws Exception {
        assertThat(Arrays.stream(DispatchReason.values()).map(DispatchReason::wire)).containsExactly("unknown", "maintenance", "request_state", "authority", "invalid_command",
            "private_plan", "target_changed", "policy_changed", "policy_denied", "plan_expired", "busy", "queue_full", "claim_failed", "audit_failed", "persistence_failed");
        assertThat(Arrays.stream(DispatchStage.values()).map(DispatchStage::wire)).containsExactly("unknown", "maintenance", "request_state", "authority", "command_validation",
            "command_guard", "file_guard", "source_plan", "target_guard", "cli_guard", "policy_guard", "busy_check", "execution_queue", "execution_claim", "decision_persistence",
            "decision_audit", "evaluation_persistence", "start_audit", "start_persistence");
        JsonMapper mapper = new JsonMapper();
        assertThat(mapper.writeValueAsString(DispatchReason.POLICY_CHANGED)).isEqualTo("\"policy_changed\"");
        assertThat(mapper.writeValueAsString(DispatchStage.EVALUATION_PERSISTENCE)).isEqualTo("\"evaluation_persistence\"");
    }
}
