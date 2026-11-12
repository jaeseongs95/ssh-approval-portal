package io.github.jaeseongs95.portal.app.execution;

import java.time.Clock;
import java.time.Instant;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.event.OperationEvents;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.operation.AuditGate;
import io.github.jaeseongs95.portal.app.operation.MaintenanceView;
import io.github.jaeseongs95.portal.app.policy.CommandPolicyStore;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.approval.ApprovalPolicy;
import io.github.jaeseongs95.portal.domain.approval.StartDecision;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.ApprovalMode;
import io.github.jaeseongs95.portal.domain.operation.DecisionRecord;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;

/**
 * The last check before an operation crosses to its target (stage 3 design 3.2 rows P0 and P3, 3.5 point 8). The adapter calls it through the {@code DispatchGuard} after
 * the connection is open and before it sends anything that changes the target, so a target or a policy that changed while the connection was being made is never
 * reached under the old approval. It asks again what the claim already asked, because the time and the world moved: the state of the operation, its deadline,
 * maintenance, the authority, the target and its revision, and for an automatic approval the revision of the policy it was decided under.
 *
 * <p>When every check passes it writes the start audit ({@code approved}, or {@code policy-execution-started} for an automatic start; fail-closed, so an audit that
 * does not become durable stops the operation with {@code AUDIT_FAILED} at {@code START_AUDIT}, decision D3-14), and then stores {@code RUNNING}, so the journal says the
 * effect has begun before the first byte is sent; a failure to store it stops the operation with {@code PERSISTENCE_FAILED} at the start. Nothing has been sent when
 * this throws.
 */
@Component
public class DispatchChecks {

    private final OperationJournal journal;
    private final TargetSource targets;
    private final MaintenanceView maintenance;
    private final ApprovalPolicy approvalPolicy;
    private final CommandPolicyStore policies;
    private final AuditGate audit;
    private final OperationEvents events;
    private final Clock clock;

    public DispatchChecks(OperationJournal journal, TargetSource targets, MaintenanceView maintenance, ApprovalPolicy approvalPolicy, CommandPolicyStore policies,
                          AuditGate audit, OperationEvents events, Clock clock) {
        this.journal = journal;
        this.targets = targets;
        this.maintenance = maintenance;
        this.approvalPolicy = approvalPolicy;
        this.policies = policies;
        this.audit = audit;
        this.events = events;
        this.clock = clock;
    }

    /** @throws DispatchRefusedException a guard refused: the operation was cancelled meanwhile, the target or the policy changed, maintenance began, or the start could not be stored */
    public void beforeDispatch(OperationId id) {
        Operation operation = journal.find(id).orElseThrow(() -> refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE));
        Instant now = clock.instant();
        if (operation.state() != OperationState.STARTING) {
            throw refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE);
        }
        TargetLookup lookup = targets.lookup(operation.targetId());
        if (!(lookup instanceof TargetLookup.Found found) || !found.target().revision().equals(operation.targetRevision())) {
            throw refused(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD);
        }
        if (approvalPolicy.checkDispatch(operation, found.target().target().readProfile(), maintenance.state(), now) instanceof StartDecision.Refused refusedStart) {
            throw new DispatchRefusedException(refusedStart.failure());
        }
        if (operation.approvalMode() == ApprovalMode.AUTOMATIC && operation.decision() instanceof DecisionRecord.Decided decided
            && !policies.current().isRevision(decided.policyRevision())) {
            throw refused(DispatchReason.POLICY_CHANGED, DispatchStage.POLICY_GUARD);
        }
        audit.appendBefore(DispatchStage.START_AUDIT, new AuditEvent(operation.approvalMode() == ApprovalMode.AUTOMATIC ? AuditAction.POLICY_EXECUTION_STARTED
            : AuditAction.APPROVED, id, "start"));
        Operation stored;
        try {
            stored = journal.save(operation.markRunning(now), operation.version());
        } catch (RequestRefusedException e) {
            if (e.code() == OperationErrorCode.OPERATION_VERSION_CONFLICT) {
                throw refused(DispatchReason.REQUEST_STATE, DispatchStage.REQUEST_STATE);
            }
            throw new DispatchRefusedException(DispatchFailure.stepFailed(DispatchStage.START_PERSISTENCE, DispatchReason.PERSISTENCE_FAILED), e);
        } catch (RuntimeException e) {
            throw new DispatchRefusedException(DispatchFailure.stepFailed(DispatchStage.START_PERSISTENCE, DispatchReason.PERSISTENCE_FAILED), e);
        }
        events.changed(stored);
    }

    private static DispatchRefusedException refused(DispatchReason reason, DispatchStage stage) {
        return new DispatchRefusedException(DispatchFailure.refused(reason, stage));
    }
}
