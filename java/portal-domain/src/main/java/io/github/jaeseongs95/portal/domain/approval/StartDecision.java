package io.github.jaeseongs95.portal.domain.approval;

import io.github.jaeseongs95.portal.domain.failure.DispatchFailure;
import java.util.Objects;

/** Whether an operation may be started now, and if not the diagnosis a refusal leaves: reason and step, nothing else. */
public sealed interface StartDecision permits StartDecision.Startable, StartDecision.Refused {

    /** The operation may be started. */
    record Startable() implements StartDecision {
    }

    /** The operation may not be started; the failure names the reason and the step. */
    record Refused(DispatchFailure failure) implements StartDecision {

        public Refused {
            Objects.requireNonNull(failure, "failure");
        }
    }
}
