package io.github.jaeseongs95.portal.domain.operation;

import io.github.jaeseongs95.portal.domain.command.ReviewReason;
import java.util.Objects;

/**
 * The automatic approval's decision about an operation, as the operation keeps it: none yet, or the kind, the reason and the policy revision the decision was made
 * under. A decision to execute is valid only while the policy revision is the same (2.x command-automation.mjs:27); the use case compares the revision before it
 * starts the operation. The evaluation that led to the decision (provider, thresholds, assessed probabilities) is the approval policy's own result and is stored
 * with it, not in this record.
 */
public sealed interface DecisionRecord permits DecisionRecord.NoDecision, DecisionRecord.Decided {

    /** True when the automatic approval decided to execute. */
    boolean isExecute();

    /** Nothing was decided: the operation goes to the owner. */
    record NoDecision() implements DecisionRecord {

        @Override
        public boolean isExecute() {
            return false;
        }
    }

    /** The automatic approval decided. */
    record Decided(DecisionKind kind, DecisionReason reason, ReviewReason reviewReason, long policyRevision) implements DecisionRecord {

        public Decided {
            Objects.requireNonNull(kind, "kind");
            Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(reviewReason, "reviewReason");
            if (policyRevision < 0) {
                throw new IllegalArgumentException("A policy revision is not negative");
            }
        }

        @Override
        public boolean isExecute() {
            return kind == DecisionKind.EXECUTE;
        }
    }
}
