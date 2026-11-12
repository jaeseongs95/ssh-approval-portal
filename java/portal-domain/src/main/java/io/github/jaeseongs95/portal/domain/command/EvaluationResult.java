package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import java.util.List;
import java.util.Objects;

/**
 * What the model evaluation of a request gave, as the use case saw it: nothing yet, a reason why no evaluation could be completed, or a valid answer. The
 * evaluators are called outside the domain (a port of the application layer); the domain only judges what came back.
 */
public sealed interface EvaluationResult
    permits EvaluationResult.NotEvaluated, EvaluationResult.BudgetExhausted, EvaluationResult.ConsentChanged, EvaluationResult.NoValidAnswer, EvaluationResult.Answered {

    /** No evaluator was asked yet. The policy then answers which evaluators to ask. */
    record NotEvaluated() implements EvaluationResult {
    }

    /** The call budget was used up before an evaluator could be asked. */
    record BudgetExhausted(List<EvaluationAttempt> attempts) implements EvaluationResult {
        public BudgetExhausted {
            attempts = List.copyOf(attempts);
        }
    }

    /** The policy or the target changed while the evaluation ran: the owner withdrew the consent to send the command out. */
    record ConsentChanged(List<EvaluationAttempt> attempts) implements EvaluationResult {
        public ConsentChanged {
            attempts = List.copyOf(attempts);
        }
    }

    /** Every evaluator that was asked failed, timed out or gave an invalid answer. */
    record NoValidAnswer(List<EvaluationAttempt> attempts) implements EvaluationResult {
        public NoValidAnswer {
            attempts = List.copyOf(attempts);
        }
    }

    /**
     * An evaluator gave a valid answer. That answer is final: a risky or low-scoring answer is never followed by a second opinion from another evaluator.
     *
     * @param evaluatorModel the model the evaluator is configured for, which a threshold must name
     */
    record Answered(EvaluatorProvider provider, String evaluatorModel, SafetyAssessment.Assessed assessment, List<EvaluationAttempt> attempts) implements EvaluationResult {
        public Answered {
            Objects.requireNonNull(provider, "provider");
            Objects.requireNonNull(evaluatorModel, "evaluatorModel");
            Objects.requireNonNull(assessment, "assessment");
            attempts = List.copyOf(attempts);
        }
    }
}
