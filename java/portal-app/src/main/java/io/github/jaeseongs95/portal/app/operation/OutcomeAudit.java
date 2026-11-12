package io.github.jaeseongs95.portal.app.operation;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.Settlement;

/**
 * The audit of an outcome that is already stored (2.x {@code finishTerminal}, approval-queue.mjs:226-229): the action is the name of the state the operation reached,
 * written after the state is durable. <b>A failure to write it never changes the outcome.</b> It is logged, and the operation is marked
 * ({@link Operation#recordAuditFailure}) so that nothing retries it automatically; the result, the state and the notification of the waiters stay as they are
 * (cases A-468, A-470, A-471).
 */
@Component
public class OutcomeAudit {

    private static final Logger LOG = LoggerFactory.getLogger(OutcomeAudit.class);

    private final AuditGate audit;
    private final OperationJournal journal;
    private final Clock clock;

    public OutcomeAudit(AuditGate audit, OperationJournal journal, Clock clock) {
        this.audit = audit;
        this.journal = journal;
        this.clock = clock;
    }

    /** Writes the final audit line of a terminal operation. */
    public void recordOutcome(Operation terminal) {
        recordEvent(terminal, new AuditEvent(actionOf(terminal), terminal.id(), noteOf(terminal)));
    }

    /** Writes any audit line about a stored operation; a line that did not become durable marks the operation and is logged. */
    public void recordEvent(Operation stored, AuditEvent event) {
        if (audit.appendAfter(event)) {
            return;
        }
        try {
            journal.save(stored.recordAuditFailure(clock.instant()), stored.version());
        } catch (RuntimeException e) {
            LOG.error("The audit failure of an operation could not be recorded", e);
        }
    }

    private AuditAction actionOf(Operation terminal) {
        return switch (terminal.state()) {
            case COMPLETED -> AuditAction.COMPLETED;
            case FAILED -> AuditAction.FAILED;
            case CANCELLED -> AuditAction.CANCELLED;
            case DENIED -> AuditAction.DENIED;
            case EXPIRED -> AuditAction.EXPIRED;
            case UNKNOWN -> AuditAction.UNKNOWN;
            case ACCEPTED, EVALUATING, PENDING, QUEUED, STARTING, RUNNING, TERMINATING ->
                throw new IllegalArgumentException("An operation in " + terminal.state() + " has no outcome to audit");
        };
    }

    /** What the line says besides the action: the code of the failure when the result has one, never text of the target. */
    private String noteOf(Operation terminal) {
        if (!(terminal.settlement() instanceof Settlement.Settled settled)) {
            return "";
        }
        return switch (settled.result()) {
            case RecordedResult.NoResult none -> "";
            case RecordedResult.Executed executed -> executed.outcome().failure() instanceof ExecutionFailure.Unclassified ? ""
                : "failure " + executed.outcome().failure().code().name();
            case RecordedResult.Refused refused -> "refused " + refused.failure().reason().wire() + " at " + refused.failure().stage().wire();
        };
    }
}
