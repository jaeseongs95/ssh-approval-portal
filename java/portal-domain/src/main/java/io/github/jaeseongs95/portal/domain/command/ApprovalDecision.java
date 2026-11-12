package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.operation.DecisionKind;
import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import java.util.List;
import java.util.Objects;

/**
 * The decision about a request: the reason (which fixes whether it runs now, waits for the owner or is refused), the first gate condition that failed when a
 * model answer was compared with a threshold, the model answer the decision rests on and the evaluator attempts that gave nothing. A decision made without the
 * owner never has a review reason, and a refusal never has a model answer.
 */
public record ApprovalDecision(DecisionReason reason, ReviewReason review, ModelEvidence model, List<EvaluationAttempt> attempts) {

    /** The explanation rule that produced the review reason (command-automation.mjs:99, {@code decisionRuleVersion}). */
    public static final String EXPLANATION_RULE_VERSION = "command-explanation-v1";

    public ApprovalDecision {
        Objects.requireNonNull(reason, "reason");
        Objects.requireNonNull(review, "review");
        Objects.requireNonNull(model, "model");
        attempts = List.copyOf(attempts);
        if (reason.isAutomatic() && review != ReviewReason.NONE) {
            throw new IllegalArgumentException("A decision that runs without the owner has no review reason");
        }
    }

    /** A decision that rests on the rule alone: no model answer, no attempts. */
    public static ApprovalDecision byRule(DecisionReason reason) {
        return new ApprovalDecision(reason, ReviewReason.NONE, new ModelEvidence.NoModelAnswer(), List.of());
    }

    /** The kind the reason fixes: only {@code policy_denied} refuses, the three automatic reasons run, every other reason leaves the request to the owner. */
    public DecisionKind kind() {
        if (reason == DecisionReason.POLICY_DENIED) {
            return DecisionKind.DENY;
        }
        return reason.isAutomatic() ? DecisionKind.EXECUTE : DecisionKind.REVIEW;
    }

    /** True when the request runs without the owner. */
    public boolean isAutomatic() {
        return reason.isAutomatic();
    }
}
