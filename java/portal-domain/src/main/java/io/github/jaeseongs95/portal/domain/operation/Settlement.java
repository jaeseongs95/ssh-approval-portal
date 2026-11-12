package io.github.jaeseongs95.portal.domain.operation;

import java.time.Instant;
import java.util.Objects;

/**
 * How the operation ended, once it has: the recorded result, how certain the portal is about the target, whether the owner has to reconcile, and when. The
 * certainty and the reconciliation always agree: reconciliation is required exactly when the certainty is {@link OutcomeCertainty#UNKNOWN} (2.x
 * operation-store.mjs:268).
 */
public sealed interface Settlement permits Settlement.Unsettled, Settlement.Settled {

    /** The operation has not ended. */
    record Unsettled() implements Settlement {
    }

    /** The operation has ended. */
    record Settled(RecordedResult result, OutcomeCertainty certainty, Reconciliation reconciliation, Instant finishedAt) implements Settlement {

        public Settled {
            Objects.requireNonNull(result, "result");
            Objects.requireNonNull(certainty, "certainty");
            Objects.requireNonNull(reconciliation, "reconciliation");
            Objects.requireNonNull(finishedAt, "finishedAt");
            if ((certainty == OutcomeCertainty.UNKNOWN) != (reconciliation == Reconciliation.REQUIRED)) {
                throw new IllegalArgumentException("Reconciliation is required exactly when the outcome is unknown");
            }
        }
    }
}
