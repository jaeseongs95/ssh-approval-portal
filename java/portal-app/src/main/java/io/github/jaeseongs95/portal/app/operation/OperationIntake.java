package io.github.jaeseongs95.portal.app.operation;

import java.time.Clock;
import java.time.Instant;

import org.springframework.stereotype.Service;

import io.github.jaeseongs95.portal.app.admission.AdmissionGate;
import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.journal.JournalInsert;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.journal.OperationQueueView;
import io.github.jaeseongs95.portal.domain.approval.ApprovalPolicy;
import io.github.jaeseongs95.portal.domain.approval.StartDecision;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.schedule.ConcurrencyLimits;
import io.github.jaeseongs95.portal.domain.schedule.OperationScheduler;

/**
 * How an operation enters and is approved (stage 3 design 8.2 groups G5 and G6, cases B-233 to B-239 and A-142 to A-145). The domain decides everything it can
 * ({@link ApprovalPolicy}, {@link OperationScheduler}, {@link Operation}); this class reads the facts, asks, writes and announces.
 *
 * <ul>
 *   <li>{@link #submit}: an operation is accepted once per request key (the journal makes the key unique, so two callers with the same key and contract get the same
 *       operation and one admission); it then waits for the owner.
 *   <li>{@link #approve}: the guards of the start, the room in the execution queue, then the audit that must be durable <em>before</em> the operation is queued
 *       (fail-closed, decision D3-14), then the queue.
 *   <li>{@link #deny}: the owner refuses; the audit of the outcome follows the stored outcome.
 * </ul>
 */
@Service
public class OperationIntake {

    private final OperationJournal journal;
    private final OperationQueueView queueView;
    private final MaintenanceView maintenance;
    private final CurrentTargets targets;
    private final ApprovalPolicy approvalPolicy;
    private final OperationScheduler scheduler;
    private final ConcurrencyLimits limits;
    private final AdmissionGate gate;
    private final AuditGate audit;
    private final OutcomeAudit outcomes;
    private final OperationWrites writes;
    private final Clock clock;

    public OperationIntake(OperationJournal journal, OperationQueueView queueView, MaintenanceView maintenance, CurrentTargets targets, ApprovalPolicy approvalPolicy,
                           OperationScheduler scheduler, ConcurrencyLimits limits, AdmissionGate gate, AuditGate audit, OutcomeAudit outcomes, OperationWrites writes, Clock clock) {
        this.journal = journal;
        this.queueView = queueView;
        this.maintenance = maintenance;
        this.targets = targets;
        this.approvalPolicy = approvalPolicy;
        this.scheduler = scheduler;
        this.limits = limits;
        this.gate = gate;
        this.audit = audit;
        this.outcomes = outcomes;
        this.writes = writes;
        this.clock = clock;
    }

    /**
     * Accepts the operation, or returns the one the same request key and contract was accepted as earlier (idempotent). The target must still be at the revision the
     * request holds; maintenance and a full request store refuse before anything is written, each with its own code. A new operation waits for the owner.
     *
     * @throws RequestRefusedException {@code TARGET_UNAVAILABLE}, {@code TARGET_REVISION_CONFLICT}, {@code MAINTENANCE_ACTIVE}, {@code REQUEST_CAPACITY_EXCEEDED},
     *     {@code OPERATION_KEY_CONFLICT} (the key was used with another contract)
     */
    public Operation submit(NewOperation spec) {
        targets.requireAt(spec.targetId(), spec.targetRevision());
        gate.require(approvalPolicy.admit(maintenance.state(), queueView.counts()));
        return switch (journal.accept(spec)) {
            case JournalInsert.Existing existing -> existing.operation();
            case JournalInsert.Inserted inserted -> {
                Operation pending = inserted.operation().awaitOwnerDecision(clock.instant());
                Operation stored = writes.store(pending, inserted.operation().version());
                outcomes.recordEvent(stored, new AuditEvent(AuditAction.SUBMITTED, stored.id(), "kind " + stored.kind().wire()));
                yield stored;
            }
        };
    }

    /**
     * Queues a pending operation under the authority. The refusal of a guard is a {@code DispatchRefusedException} that names the reason and the step; an audit that
     * did not become durable stops the operation at {@link DispatchStage#START_AUDIT} and leaves it pending (2.x wrote {@code execution-queued} at that step).
     *
     * @throws RequestRefusedException {@code OPERATION_NOT_FOUND}, {@code TARGET_REVISION_CONFLICT}, or the code of the queue limit that is reached
     * @throws DispatchRefusedException a start guard refused, or the audit failed
     */
    public Operation approve(OperationId id, StartAuthority authority) {
        Operation operation = require(id);
        targets.requireAt(operation.targetId(), operation.targetRevision());
        Instant now = clock.instant();
        if (approvalPolicy.checkStart(operation, authority, maintenance.state(), now) instanceof StartDecision.Refused refused) {
            throw new DispatchRefusedException(refused.failure());
        }
        gate.require(scheduler.admitToQueue(operation.targetId(), queueView.schedulingView(limits, now, limits.queueCapacity().value())));
        audit.appendBefore(DispatchStage.START_AUDIT, new AuditEvent(AuditAction.EXECUTION_QUEUED, id, "authority " + authority.mode().wire()));
        return writes.store(operation.enqueue(authority, now), operation.version());
    }

    /** The owner refuses a waiting operation; nothing ran. */
    public Operation deny(OperationId id) {
        Operation operation = require(id);
        Operation stored = writes.store(operation.deny(clock.instant()), operation.version());
        outcomes.recordOutcome(stored);
        return stored;
    }

    private Operation require(OperationId id) {
        return journal.find(id).orElseThrow(() -> new RequestRefusedException(RequestErrorCode.OPERATION_NOT_FOUND));
    }
}
