package io.github.jaeseongs95.portal.domain.operation;

import java.util.Objects;

/**
 * What the owner established when comparing the target with the record of an unknown operation. An unknown operation leaves the state only through this
 * evidence, and the evidence has to name what is true on the target: the operation took effect and finished, it took effect and failed, or it never took effect.
 */
public sealed interface ReconciliationEvidence permits ReconciliationEvidence.Completed, ReconciliationEvidence.Failed, ReconciliationEvidence.NeverRan {

    /** The operation took effect and finished; the evidence must confirm it. */
    record Completed(CompletionEvidence evidence) implements ReconciliationEvidence {

        public Completed {
            Objects.requireNonNull(evidence, "evidence");
            if (!evidence.confirmsCompletion()) {
                throw new IllegalArgumentException("Completed needs evidence that confirms the completion");
            }
        }
    }

    /** The operation took effect and failed. */
    record Failed() implements ReconciliationEvidence {
    }

    /** The operation never took effect on the target; it is cancelled. */
    record NeverRan() implements ReconciliationEvidence {
    }
}
