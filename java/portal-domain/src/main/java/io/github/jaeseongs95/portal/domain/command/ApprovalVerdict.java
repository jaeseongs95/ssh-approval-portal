package io.github.jaeseongs95.portal.domain.command;

import java.util.List;
import java.util.Objects;

/** What the approval policy answers: a decision, or the list of evaluators to ask before it can decide. */
public sealed interface ApprovalVerdict permits ApprovalVerdict.Decided, ApprovalVerdict.NeedsEvaluation {

    record Decided(ApprovalDecision decision) implements ApprovalVerdict {
        public Decided {
            Objects.requireNonNull(decision, "decision");
        }
    }

    /** Ask these evaluators in this order; the first one that gives a valid answer decides. */
    record NeedsEvaluation(List<EvaluatorProvider> order) implements ApprovalVerdict {
        public NeedsEvaluation {
            order = List.copyOf(order);
            if (order.isEmpty()) {
                throw new IllegalArgumentException("An evaluation asks at least one evaluator");
            }
        }
    }
}
