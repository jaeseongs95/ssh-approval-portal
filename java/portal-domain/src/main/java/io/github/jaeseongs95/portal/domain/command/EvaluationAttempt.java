package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import java.util.Objects;

/**
 * One try of one evaluator that gave no usable answer. Only fixed vocabulary is kept: the evaluator, and either that it was not configured or the failure and
 * diagnostic from the closed lists; no provider text, payload or number is part of an attempt (command-automation.mjs:57-58, 81-82, case RC-A-450).
 */
public sealed interface EvaluationAttempt permits EvaluationAttempt.NotConfigured, EvaluationAttempt.Failed {

    EvaluatorProvider provider();

    /** The evaluator is not set up (or asks a question of another version), so it was not called. */
    record NotConfigured(EvaluatorProvider provider) implements EvaluationAttempt {
        public NotConfigured {
            Objects.requireNonNull(provider, "provider");
        }
    }

    /** The evaluator was called and gave no valid answer. */
    record Failed(EvaluatorProvider provider, SafetyAssessment.Unavailable failure) implements EvaluationAttempt {
        public Failed {
            Objects.requireNonNull(provider, "provider");
            Objects.requireNonNull(failure, "failure");
        }
    }
}
