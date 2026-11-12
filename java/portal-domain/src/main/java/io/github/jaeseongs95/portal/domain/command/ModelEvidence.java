package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import java.util.Objects;

/** The model answer a decision rests on, or the fact that no model answer was involved. It is kept with the decision so the owner can see why. */
public sealed interface ModelEvidence permits ModelEvidence.NoModelAnswer, ModelEvidence.ModelAnswer {

    record NoModelAnswer() implements ModelEvidence {
    }

    /** The evaluator, its valid answer and the threshold the answer was compared with. */
    record ModelAnswer(EvaluatorProvider provider, SafetyAssessment.Assessed assessment, ThresholdLookup threshold) implements ModelEvidence {
        public ModelAnswer {
            Objects.requireNonNull(provider, "provider");
            Objects.requireNonNull(assessment, "assessment");
            Objects.requireNonNull(threshold, "threshold");
        }
    }
}
