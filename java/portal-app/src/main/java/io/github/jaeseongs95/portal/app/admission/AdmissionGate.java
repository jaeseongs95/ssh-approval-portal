package io.github.jaeseongs95.portal.app.admission;

import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.approval.AdmissionDecision;
import io.github.jaeseongs95.portal.domain.error.CapacityErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionAttempt;
import io.github.jaeseongs95.portal.domain.error.OperationErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.schedule.SaturationReason;

/**
 * Turns the answers of the queue's judgements into the contract errors, so that a full request store, a full execution queue, an exhausted reconciliation budget, a
 * closed window of maintenance and a lost transport are five different answers (defect D-0038; 2.x answered the first with the code-less text "Queue full").
 * Every refusal here is given before anything was sent to a target ({@link ExecutionAttempt#NOT_ATTEMPTED}), and the ones that a later try can overcome say so.
 */
@Component
public class AdmissionGate {

    /** Lets an admitted request pass and refuses the others with the code of the limit that stopped them. */
    public void require(AdmissionDecision decision) {
        switch (decision) {
            case AdmissionDecision.Admit admit -> {
            }
            case AdmissionDecision.RejectedMaintenance rejected -> throw refused(rejected.errorCode());
            case AdmissionDecision.RejectedCapacity rejected -> throw refused(rejected.errorCode());
        }
    }

    /**
     * The code for operations that wait and cannot start under the limits now. It is no failure of the operation (it stays queued); a caller that has to answer a
     * request over it uses this code and never a connection failure.
     */
    public ErrorCode codeFor(SaturationReason reason) {
        return switch (reason) {
            case GLOBAL_CONCURRENCY, TARGET_CONCURRENCY, CONFLICT_FENCE -> CapacityErrorCode.EXECUTION_QUEUE_FULL;
            case UNKNOWN_BUDGET -> OperationErrorCode.OPERATION_RECONCILIATION_CAPACITY;
        };
    }

    private static RequestRefusedException refused(ErrorCode code) {
        return new RequestRefusedException(code, code.retryableByDefault(), ExecutionAttempt.NOT_ATTEMPTED);
    }
}
