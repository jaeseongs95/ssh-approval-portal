package io.github.jaeseongs95.portal.app.operation;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.audit.AuditFailedException;
import io.github.jaeseongs95.portal.app.audit.AuditLog;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;

/**
 * The one place that turns an audit failure into the answer of a use case (stage 3 design 11.1, decision D3-14). {@link AuditFailedException} is an infrastructure
 * exception of the audit port; it does not leave a use case. An audit that has to be written <em>before</em> something starts is fail-closed: a failure stops the
 * operation with {@code DispatchRefusedException(StepFailed(stage, AUDIT_FAILED))} and keeps the cause. An audit of an outcome that is already durable cannot undo
 * it: a failure is logged and reported to the caller, who marks the operation so that nothing retries it automatically.
 */
@Component
public class AuditGate {

    private static final Logger LOG = LoggerFactory.getLogger(AuditGate.class);

    private final AuditLog audit;

    public AuditGate(AuditLog audit) {
        this.audit = audit;
    }

    /**
     * Writes an audit line that the next step depends on.
     *
     * @param stage {@link DispatchStage#DECISION_AUDIT} or {@link DispatchStage#START_AUDIT}
     * @throws DispatchRefusedException when the line did not become durable; the cause is the audit failure
     * @throws IllegalArgumentException when the stage is not an audit stage
     */
    public void appendBefore(DispatchStage stage, AuditEvent event) {
        if (stage != DispatchStage.DECISION_AUDIT && stage != DispatchStage.START_AUDIT) {
            throw new IllegalArgumentException("Not an audit stage: " + stage);
        }
        try {
            audit.append(event);
        } catch (AuditFailedException e) {
            throw new DispatchRefusedException(DispatchFailure.stepFailed(stage, DispatchReason.AUDIT_FAILED), e);
        }
    }

    /** Writes the audit line of an outcome that is already stored. Returns false, after it logged the cause, when the line did not become durable. */
    public boolean appendAfter(AuditEvent event) {
        try {
            audit.append(event);
            return true;
        } catch (AuditFailedException e) {
            LOG.error("The audit line of an operation outcome could not be written", e);
            return false;
        }
    }
}
