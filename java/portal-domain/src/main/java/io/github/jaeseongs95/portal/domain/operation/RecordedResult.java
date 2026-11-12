package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.failure.DispatchFailure;
import java.util.Objects;

/** What the operation kept of how it ended: nothing (it never reached an executor), the executor's outcome, or the refusal that stopped it before dispatch. */
public sealed interface RecordedResult permits RecordedResult.NoResult, RecordedResult.Executed, RecordedResult.Refused {

    /** The operation ended without an executor: denied, expired, cancelled before dispatch, or settled by recovery. */
    record NoResult() implements RecordedResult {
    }

    /** An executor ran and reported the outcome. */
    record Executed(ExecutionOutcome outcome) implements RecordedResult {

        public Executed {
            Objects.requireNonNull(outcome, "outcome");
        }
    }

    /** A guard stopped the operation before dispatch; the failure names the reason and the step. */
    record Refused(DispatchFailure failure) implements RecordedResult {

        public Refused {
            Objects.requireNonNull(failure, "failure");
        }
    }
}
