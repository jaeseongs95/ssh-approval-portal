package io.github.jaeseongs95.portal.store.policy;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.command.EvaluatorProvider;
import io.github.jaeseongs95.portal.domain.command.QuestionVersion;

/**
 * Table {@code command_policy_threshold}: one threshold per (target, evaluator provider). {@code minConfidence} is the nullable column of the legacy basis; a
 * probability threshold stores {@code null} (the CHECK {@code ck_policy_threshold_shape} ties the two). Written with {@code insert}, deleted with a statement
 * (composite key, see {@link PolicyNameRow}).
 */
@Table("command_policy_threshold")
public record PolicyThresholdRow(@Id String targetId, EvaluatorProvider provider, String model, QuestionVersion questionVersion, ThresholdBasis basis,
                                 double minLowRisk, Double minConfidence, String validationRef) {
}
