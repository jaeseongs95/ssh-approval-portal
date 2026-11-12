package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import java.util.Objects;

/**
 * The threshold form of older policies, which also asked for a minimum confidence. A stored policy of this form is read and returned unchanged, but it never
 * approves a command: it has no probability basis, so the gate reports {@link ReviewReason#BASIS_MISMATCH} (or an earlier mismatch) and the owner decides
 * (command-policy.mjs:63-66, case RC-A-421).
 */
public record ConfidenceThreshold(ThresholdTerms terms, double minConfidence) implements Threshold {

    public ConfidenceThreshold {
        Objects.requireNonNull(terms, "terms");
        if (!ThresholdTerms.isAboveHalf(minConfidence)) {
            throw new IllegalArgumentException("A threshold confidence is above 0.5 and at most 1");
        }
    }

    @Override
    public ReviewReason review(String evaluatorModel, SafetyAssessment.Assessed assessment) {
        if (!terms.modelMatches(evaluatorModel)) {
            return ReviewReason.MODEL_MISMATCH;
        }
        return terms.questionVersion().isCurrent() ? ReviewReason.BASIS_MISMATCH : ReviewReason.QUESTION_MISMATCH;
    }
}
