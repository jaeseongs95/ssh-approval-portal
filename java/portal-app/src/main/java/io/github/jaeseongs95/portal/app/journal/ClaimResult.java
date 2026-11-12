package io.github.jaeseongs95.portal.app.journal;

import java.util.Objects;

import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.schedule.SaturationReason;

/**
 * The answer of {@link ClaimStore#claim}; 2.x answered {@code null} for every non-success (defect D-0038: the reasons were not told apart).
 */
public sealed interface ClaimResult permits ClaimResult.Claimed, ClaimResult.NotQueued, ClaimResult.Contended, ClaimResult.Saturated {

    /** The operation is now {@code STARTING} and holds its slots. */
    record Claimed(Operation operation) implements ClaimResult {

        public Claimed {
            Objects.requireNonNull(operation, "operation");
        }
    }

    /** The operation is no longer {@code QUEUED} at the expected version (cancelled, expired or claimed by another call). */
    record NotQueued() implements ClaimResult {
    }

    /** Another claim took the same slot number or the same conflict fence in the same instant; the next round decides again, nothing is retried or replayed. */
    record Contended() implements ClaimResult {
    }

    /** A limit forbids the claim now. */
    record Saturated(SaturationReason reason) implements ClaimResult {

        public Saturated {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
