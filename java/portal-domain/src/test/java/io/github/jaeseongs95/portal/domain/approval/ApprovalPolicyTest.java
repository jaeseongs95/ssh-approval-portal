package io.github.jaeseongs95.portal.domain.approval;

import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.DIGESTER;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.REVISION;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.T0;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.id;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.pending;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.queued;
import static io.github.jaeseongs95.portal.domain.operation.OperationFixtures.starting;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.contract.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.contract.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.failure.DispatchFailure;
import io.github.jaeseongs95.portal.domain.failure.DispatchReason;
import io.github.jaeseongs95.portal.domain.failure.DispatchStage;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.RequestKey;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.DecisionKind;
import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import io.github.jaeseongs95.portal.domain.operation.DecisionRecord;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.ReviewReason;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class ApprovalPolicyTest {

    private static final Instant NOW = T0.plusSeconds(10);
    private final ApprovalPolicy policy = new ApprovalPolicy(new Capacity(100));
    private final MaintenanceState open = new MaintenanceState.Open();
    private final MaintenanceState reserved = new MaintenanceState.Reserved();

    @Test
    @DisplayName("S2-SC-03 a request enters until the store holds as many open requests as the capacity; then it is refused with REQUEST_CAPACITY_EXCEEDED")
    void requestStoreCapacity() {
        assertThat(policy.admit(open, counts(OperationState.PENDING, 99))).isEqualTo(new AdmissionDecision.Admit());
        AdmissionDecision full = policy.admit(open, counts(OperationState.PENDING, 100));
        assertThat(full).isEqualTo(new AdmissionDecision.RejectedCapacity(CapacityKind.REQUEST_STORE));
        assertThat(((AdmissionDecision.RejectedCapacity) full).errorCode()).isEqualTo(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED);
        assertThat(policy.admit(open, counts(OperationState.QUEUED, 60, OperationState.RUNNING, 40))).isInstanceOf(AdmissionDecision.RejectedCapacity.class);
        assertThat(policy.admit(open, counts(OperationState.COMPLETED, 5000, OperationState.UNKNOWN, 50))).as("history does not occupy the store").isEqualTo(new AdmissionDecision.Admit());
        assertThatThrownBy(() -> new ApprovalPolicy(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("RC-A-083 S2-SC-03 a request is refused during maintenance, retryably, before the capacity is looked at")
    void maintenanceRefusesFirst() {
        AdmissionDecision refused = policy.admit(reserved, StateCounts.none());
        assertThat(refused).isEqualTo(new AdmissionDecision.RejectedMaintenance());
        assertThat(((AdmissionDecision.RejectedMaintenance) refused).errorCode()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE);
        assertThat(policy.admit(reserved, counts(OperationState.PENDING, 100))).isEqualTo(new AdmissionDecision.RejectedMaintenance());
    }

    @Test
    @DisplayName("S2-SC-03 the three capacity kinds have three distinct reasons: request store, queue, reconciliation budget")
    void capacityKindsHaveTheirOwnCodes() {
        assertThat(CapacityKind.REQUEST_STORE.errorCode()).isEqualTo(CapacityErrorCode.REQUEST_CAPACITY_EXCEEDED);
        assertThat(CapacityKind.EXECUTION_QUEUE.errorCode()).isEqualTo(OperationErrorCode.OPERATION_QUEUE_FULL);
        assertThat(CapacityKind.TARGET_QUEUE.errorCode()).isEqualTo(OperationErrorCode.OPERATION_QUEUE_FULL);
        assertThat(CapacityKind.RECONCILIATION.errorCode()).isEqualTo(OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY);
    }

    @Test
    @DisplayName("RC-A-765 RC-A-083 the owner may start a pending operation; the guards refuse in the order maintenance, state, deadline, authority")
    void startGuards() {
        Operation pending = pending();
        assertThat(policy.checkStart(pending, new StartAuthority.Owner(), open, NOW)).isEqualTo(new StartDecision.Startable());
        assertThat(policy.checkStart(pending, new StartAuthority.Owner(), reserved, NOW)).isEqualTo(refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE));
        assertThat(policy.checkStart(queued(), new StartAuthority.Owner(), open, NOW)).as("only a pending operation is started").isEqualTo(refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE));
        Instant expiry = T0.plus(Duration.ofHours(1));
        assertThat(policy.checkStart(pending, new StartAuthority.Owner(), open, expiry.minusNanos(1))).isEqualTo(new StartDecision.Startable());
        assertThat(policy.checkStart(pending, new StartAuthority.Owner(), open, expiry)).as("at the deadline the request is no longer executable")
            .isEqualTo(refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE));
        assertThat(policy.checkStart(pending, new StartAuthority.Policy(StartAuthority.PolicyScope.UPLOAD), open, NOW)).isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY));
        assertThat(policy.checkStart(pending, new StartAuthority.Owner(), reserved, expiry)).as("maintenance is asked first").isEqualTo(refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE));
    }

    @Test
    @DisplayName("RC-A-157 S2-SC-03 a server policy starts a command only with a decision to execute; a read authority needs none; a file policy refuses at the file guard")
    void policyAuthorityNeedsADecision() {
        Operation pending = pending();
        StartAuthority command = new StartAuthority.Policy(StartAuthority.PolicyScope.COMMAND);
        assertThat(policy.checkStart(pending, command, open, NOW)).isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY));
        Operation reviewed = pending.recordDecision(new DecisionRecord.Decided(DecisionKind.REVIEW, DecisionReason.MODEL_REVIEW, ReviewReason.BELOW_THRESHOLD, 3), T0.plusSeconds(2));
        assertThat(policy.checkStart(reviewed, command, open, NOW)).isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY));
        Operation approved = pending.recordDecision(new DecisionRecord.Decided(DecisionKind.EXECUTE, DecisionReason.COMMAND_SET, ReviewReason.NONE, 3), T0.plusSeconds(2));
        assertThat(policy.checkStart(approved, command, open, NOW)).isEqualTo(new StartDecision.Startable());
        assertThat(policy.checkStart(pending, new StartAuthority.Policy(StartAuthority.PolicyScope.READ), open, NOW)).isEqualTo(new StartDecision.Startable());
        Operation upload = pendingUpload();
        StartAuthority files = new StartAuthority.Policy(StartAuthority.PolicyScope.UPLOAD);
        assertThat(policy.checkStart(upload, files, open, NOW)).isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.FILE_GUARD));
        assertThat(policy.checkStart(upload, new StartAuthority.Policy(StartAuthority.PolicyScope.COMMAND), open, NOW)).isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY));
        assertThat(policy.checkStart(upload, new StartAuthority.Owner(), open, NOW)).isEqualTo(new StartDecision.Startable());
    }

    @Test
    @DisplayName("RC-B-197 the guards are asked again after the claim: a claimed operation past its deadline, or under maintenance, is refused before dispatch")
    void dispatchGuards() {
        Operation claimed = starting();
        assertThat(policy.checkDispatch(claimed, open, NOW)).isEqualTo(new StartDecision.Startable());
        assertThat(policy.checkDispatch(claimed, reserved, NOW)).isEqualTo(refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE));
        assertThat(policy.checkDispatch(claimed, open, T0.plus(Duration.ofHours(1)))).isEqualTo(refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE));
        assertThat(policy.checkDispatch(queued(), open, NOW)).as("only a claimed operation is dispatched").isEqualTo(refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE));
        Operation automaticWithoutDecision = pending().enqueue(new StartAuthority.Policy(StartAuthority.PolicyScope.COMMAND), T0.plusSeconds(2)).claim(T0.plusSeconds(3));
        assertThat(policy.checkDispatch(automaticWithoutDecision, open, NOW)).as("an automatic start without a decision to execute is not dispatched")
            .isEqualTo(refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY));
    }

    private static StartDecision refused(DispatchReason reason, DispatchStage stage) {
        return new StartDecision.Refused(DispatchFailure.refused(reason, stage));
    }

    private static StateCounts counts(Object... pairs) {
        Map<OperationState, Integer> counts = new EnumMap<>(OperationState.class);
        for (int i = 0; i < pairs.length; i += 2) {
            counts.put((OperationState) pairs[i], (Integer) pairs[i + 1]);
        }
        return new StateCounts(counts);
    }

    private static Operation pendingUpload() {
        NewOperation spec = NewOperation.of(DIGESTER, new RequestKey("upload-request-key-1"), new OwnerId("fixture-owner"), new TargetId("alpha"), REVISION,
            new ProfileAlias("write-profile"), new UploadInput(new ArtifactId("b".repeat(48)), new PosixRemotePath("/tmp/file.bin"), new FileName("file.bin"), 10,
                new Digest("d".repeat(64)), OverwriteMode.REPLACE, Elevation.NONE, new FileBinding.Unbound(), UploadProtocol.UNSPECIFIED),
            new ConflictKey.None(), new Deadline.None());
        return Operation.accept(spec, id('7'), T0).awaitOwnerDecision(T0.plusSeconds(1));
    }
}
