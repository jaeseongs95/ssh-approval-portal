package io.github.jaeseongs95.portal.app.operation;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.audit.AuditEvent;
import io.github.jaeseongs95.portal.app.audit.AuditFailedException;
import io.github.jaeseongs95.portal.app.audit.AuditLog;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.id.OperationId;

/** An audit failure does not leave a use case as itself (stage 3 design 11.1, decision D3-14; S3-UC-02, cases A-145, A-468, A-470, A-471). */
class AuditGateTest {

    private static final AuditEvent EVENT = new AuditEvent(AuditAction.EXECUTION_QUEUED, new OperationId("c".repeat(48)), "authority owner");

    private static final class FailingAudit implements AuditLog {

        private final List<AuditEvent> attempts = new ArrayList<>();

        @Override
        public void append(AuditEvent event) {
            attempts.add(event);
            throw new AuditFailedException("audit unavailable: secret-detail");
        }
    }

    @Test
    @DisplayName("S3-UC-02 RC-A-145 an audit that must come first and fails stops the operation with StepFailed(DECISION_AUDIT, AUDIT_FAILED) and keeps the cause")
    void decisionAuditFailureIsADispatchRefusal() {
        FailingAudit audit = new FailingAudit();
        AuditGate gate = new AuditGate(audit);
        assertThatThrownBy(() -> gate.appendBefore(DispatchStage.DECISION_AUDIT, EVENT)).isInstanceOfSatisfying(DispatchRefusedException.class, refused -> {
            assertThat(refused.failure()).isEqualTo(DispatchFailure.stepFailed(DispatchStage.DECISION_AUDIT, DispatchReason.AUDIT_FAILED));
            assertThat(refused.getCause()).isInstanceOf(AuditFailedException.class);
            assertThat(refused.getMessage()).doesNotContain("secret-detail");
        });
        assertThat(audit.attempts).containsExactly(EVENT);
    }

    @Test
    @DisplayName("S3-UC-02 RC-A-468 the same conversion at the start step: StepFailed(START_AUDIT, AUDIT_FAILED); no other stage is an audit stage")
    void startAuditFailureAndTheStageCheck() {
        AuditGate gate = new AuditGate(new FailingAudit());
        assertThatThrownBy(() -> gate.appendBefore(DispatchStage.START_AUDIT, EVENT)).isInstanceOfSatisfying(DispatchRefusedException.class,
            refused -> assertThat(refused.failure()).isEqualTo(DispatchFailure.stepFailed(DispatchStage.START_AUDIT, DispatchReason.AUDIT_FAILED)));
        assertThatThrownBy(() -> gate.appendBefore(DispatchStage.TARGET_GUARD, EVENT)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-UC-02 RC-A-470 RC-A-471 an audit of an outcome that is already stored answers false when it fails, and true when it is written; the exception does not leave")
    void outcomeAuditCannotUndoTheOutcome() {
        List<AuditEvent> written = new ArrayList<>();
        AuditGate working = new AuditGate(written::add);
        assertThat(working.appendAfter(EVENT)).isTrue();
        assertThat(written).containsExactly(EVENT);
        assertThat(new AuditGate(new FailingAudit()).appendAfter(EVENT)).isFalse();
    }

    @Test
    @DisplayName("S3-UC-02 a working audit lets the step go on without a conversion")
    void workingAuditChangesNothing() {
        List<AuditEvent> written = new ArrayList<>();
        new AuditGate(written::add).appendBefore(DispatchStage.DECISION_AUDIT, EVENT);
        assertThat(written).containsExactly(EVENT);
    }
}
