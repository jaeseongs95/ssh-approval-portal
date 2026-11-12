package io.github.jaeseongs95.portal.domain.approval;

import io.github.jaeseongs95.portal.domain.capacity.Capacity;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationKind;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.operation.StateCounts;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import java.time.Instant;
import java.util.Objects;

/**
 * The rules of the approval step, as judgements over values: whether a request may enter, and whether an approved operation may be started. It holds no state of its
 * own and owns neither the queue nor the clock; the moment is an argument, read once by the use case (2.x approval-queue.mjs, the approval policy half of it).
 *
 * <p>The order of a start check is the order of the guards in 2.x {@code start} and {@code checkStart}: maintenance, the state of the request, its deadline, the
 * authority, and for an automatic start the policy's decision to execute. The first guard that refuses names the reason and the step.
 */
public final class ApprovalPolicy {

    private final Capacity requestCapacity;

    /** The policy for an approval store that holds at most {@code requestCapacity} open requests (2.x BRIDGE_REQUEST_CAPACITY, default 100). */
    public ApprovalPolicy(Capacity requestCapacity) {
        this.requestCapacity = Objects.requireNonNull(requestCapacity, "requestCapacity");
    }

    /**
     * Whether a new request may enter. Maintenance refuses first; then the store: it is full when the number of open requests (those not yet in a terminal state)
     * has reached the capacity. A terminal operation is history and does not occupy the store (2.x kept it for an hour in memory).
     */
    public AdmissionDecision admit(MaintenanceState maintenance, StateCounts counts) {
        Objects.requireNonNull(maintenance, "maintenance");
        Objects.requireNonNull(counts, "counts");
        return switch (maintenance) {
            case MaintenanceState.Reserved reserved -> new AdmissionDecision.RejectedMaintenance();
            case MaintenanceState.Open open -> counts.open() >= requestCapacity.value()
                ? new AdmissionDecision.RejectedCapacity(CapacityKind.REQUEST_STORE) : new AdmissionDecision.Admit();
        };
    }

    /** Whether a pending operation may be started now, by the authority (2.x {@code start}). */
    public StartDecision checkStart(Operation operation, StartAuthority authority, MaintenanceState maintenance, Instant at) {
        return check(operation, OperationState.PENDING, authority, maintenance, at);
    }

    /** Whether a claimed operation may cross into execution now: the guards are asked again after the claim, because time and the policy moved (2.x {@code executeScheduled}). */
    public StartDecision checkDispatch(Operation operation, MaintenanceState maintenance, Instant at) {
        Objects.requireNonNull(operation, "operation");
        StartAuthority authority = switch (operation.approvalMode()) {
            case AUTOMATIC -> new StartAuthority.Policy(policyScopeOf(operation.kind()));
            case OWNER, NOT_DECIDED -> new StartAuthority.Owner();
        };
        return check(operation, OperationState.STARTING, authority, maintenance, at);
    }

    /**
     * Whether a claimed operation may cross into execution now, when the caller knows the <em>read profile</em> of the operation's target. 2.x kept the authority an
     * operation was started with in memory ({@code job.executionAuthority}, approval-queue.mjs:185) and asked again under it at dispatch (:254); the journal keeps no
     * authority scope, so the one start that needs it is derived from what the journal does keep: a command that is run on the read profile, started by the server
     * (automatic) with no decision to execute, is the start of the server's read authority, which needs no decision (cases RC-A-467, RC-A-469). Any other automatic start is
     * judged as {@link #checkDispatch(Operation, MaintenanceState, Instant)} does. The read start is no way round the decision rule: an automatic command without an
     * execute decision is queued only under the read authority ({@link #checkStart} refuses it under the command authority), and the use case that starts a read command
     * is the one that classifies it as read-only.
     *
     * @param readProfile the read profile of the operation's target
     */
    public StartDecision checkDispatch(Operation operation, ProfileAlias readProfile, MaintenanceState maintenance, Instant at) {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(readProfile, "readProfile");
        if (!startedUnderReadAuthority(operation, readProfile)) {
            return checkDispatch(operation, maintenance, at);
        }
        return check(operation, OperationState.STARTING, new StartAuthority.Policy(StartAuthority.PolicyScope.READ), maintenance, at);
    }

    private boolean startedUnderReadAuthority(Operation operation, ProfileAlias readProfile) {
        return operation.approvalMode() == ApprovalMode.AUTOMATIC && operation.kind() == OperationKind.COMMAND && operation.profile().equals(readProfile)
            && !operation.decision().isExecute();
    }

    private StartDecision check(Operation operation, OperationState required, StartAuthority authority, MaintenanceState maintenance, Instant at) {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(authority, "authority");
        Objects.requireNonNull(maintenance, "maintenance");
        Objects.requireNonNull(at, "at");
        if (maintenance instanceof MaintenanceState.Reserved) {
            return refused(DispatchReason.MAINTENANCE, DispatchStage.MAINTENANCE);
        }
        if (operation.state() != required || operation.expiry().isReached(at)) {
            return refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE);
        }
        if (!authority.covers(operation.kind())) {
            return refused(DispatchReason.AUTHORITY, DispatchStage.AUTHORITY);
        }
        boolean automatic = authority.mode() == ApprovalMode.AUTOMATIC;
        boolean readAuthority = authority instanceof StartAuthority.Policy policy && policy.scope() == StartAuthority.PolicyScope.READ;
        if (automatic && !readAuthority && !operation.decision().isExecute()) {
            boolean file = operation.kind() == OperationKind.UPLOAD || operation.kind() == OperationKind.DOWNLOAD;
            return refused(DispatchReason.AUTHORITY, file ? DispatchStage.FILE_GUARD : DispatchStage.AUTHORITY);
        }
        return new StartDecision.Startable();
    }

    private static StartAuthority.PolicyScope policyScopeOf(OperationKind kind) {
        return switch (kind) {
            case COMMAND, SOURCE, AGENT_CLI -> StartAuthority.PolicyScope.COMMAND;
            case UPLOAD -> StartAuthority.PolicyScope.UPLOAD;
            case DOWNLOAD -> StartAuthority.PolicyScope.DOWNLOAD;
        };
    }

    private static StartDecision refused(DispatchReason reason, DispatchStage stage) {
        return new StartDecision.Refused(DispatchFailure.refused(reason, stage));
    }
}
