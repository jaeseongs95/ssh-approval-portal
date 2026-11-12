package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.operation.ReviewReason;
import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import io.github.jaeseongs95.portal.domain.safety.SafetyLabel;
import java.util.Objects;

/**
 * The threshold in force: the evaluator must answer {@code low_risk} with a {@code low_risk} probability of at least {@code minLowRisk}; the boundary itself
 * passes (0.9 passes a 0.9 threshold, 0.899 does not). The confidence the evaluator reports is a diagnostic and not a second gate, so this form has no
 * confidence field (basis {@code safety-probability-v1}, command-policy.mjs:8).
 */
public record ProbabilityThreshold(ThresholdTerms terms) implements Threshold {

    /** The basis name of this form, as it is written in a stored policy. */
    public static final String BASIS = "safety-probability-v1";

    public ProbabilityThreshold {
        Objects.requireNonNull(terms, "terms");
    }

    @Override
    public ReviewReason review(String evaluatorModel, SafetyAssessment.Assessed assessment) {
        if (!terms.modelMatches(evaluatorModel)) {
            return ReviewReason.MODEL_MISMATCH;
        }
        if (!terms.questionVersion().isCurrent()) {
            return ReviewReason.QUESTION_MISMATCH;
        }
        if (assessment.label() != SafetyLabel.LOW_RISK) {
            return ReviewReason.HIGH_RISK;
        }
        return assessment.lowRisk().value() < terms.minLowRisk() ? ReviewReason.BELOW_THRESHOLD : ReviewReason.NONE;
    }
}
