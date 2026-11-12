package io.github.jaeseongs95.portal.store.journal;

import org.springframework.data.annotation.Id;
import org.springframework.data.relational.core.mapping.Table;

import io.github.jaeseongs95.portal.domain.command.ReviewReason;
import io.github.jaeseongs95.portal.domain.operation.DecisionKind;
import io.github.jaeseongs95.portal.domain.operation.DecisionReason;

/**
 * Table {@code operation_decision}: the decision of the automatic approval that the domain keeps ({@code DecisionRecord.Decided}). The other columns of the table
 * (provider, thresholds, assessment, tokens, latency) are for the automation metrics of stage 4 and stay NULL until that stage writes them.
 */
@Table("operation_decision")
public record OperationDecisionRow(@Id String operationId, DecisionKind decision, DecisionReason reasonCode, ReviewReason reviewReason, long policyRevision) {
}
