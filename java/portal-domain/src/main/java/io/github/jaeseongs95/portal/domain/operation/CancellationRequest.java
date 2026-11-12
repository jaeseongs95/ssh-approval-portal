package io.github.jaeseongs95.portal.domain.operation;

import java.time.Instant;
import java.util.Objects;

/** Whether, and when, a cancel was asked for while the operation was running. A cancel before dispatch is certain and needs no record: the operation is cancelled. */
public sealed interface CancellationRequest permits CancellationRequest.NotRequested, CancellationRequest.RequestedAt {

    /** Nobody asked for a cancel. */
    record NotRequested() implements CancellationRequest {
    }

    /** A cancel was asked for at the instant; the stop of the operation is not confirmed. */
    record RequestedAt(Instant instant) implements CancellationRequest {

        public RequestedAt {
            Objects.requireNonNull(instant, "instant");
        }
    }
}
