package io.github.jaeseongs95.portal.domain.approval;

import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import java.util.Objects;

/**
 * Whether a request may enter, and if not why: the answer of {@link ApprovalPolicy#admit} and of the scheduler's queue gate. It is a result and not an exception
 * because a full queue or a maintenance window is an expected answer; the one that reports it turns it into a contract error.
 */
public sealed interface AdmissionDecision permits AdmissionDecision.Admit, AdmissionDecision.RejectedMaintenance, AdmissionDecision.RejectedCapacity {

    /** The request may enter. */
    record Admit() implements AdmissionDecision {
    }

    /** The bridge is under maintenance and takes no new request. A retry later can succeed. */
    record RejectedMaintenance() implements AdmissionDecision {

        public ErrorCode errorCode() {
            return RequestErrorCode.MAINTENANCE_ACTIVE;
        }
    }

    /** A limit is reached. */
    record RejectedCapacity(CapacityKind kind) implements AdmissionDecision {

        public RejectedCapacity {
            Objects.requireNonNull(kind, "kind");
        }

        public ErrorCode errorCode() {
            return kind.errorCode();
        }
    }
}
