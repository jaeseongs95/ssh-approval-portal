package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.operation.ReviewReason;
import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;

/**
 * The condition under which a model answer may approve a command. Two forms exist and only one of them can approve: {@link ProbabilityThreshold} (the form in
 * force, basis {@code safety-probability-v1}) and {@link ConfidenceThreshold} (the form of older policies, read and kept but never used for approval).
 */
public sealed interface Threshold permits ProbabilityThreshold, ConfidenceThreshold {

    ThresholdTerms terms();

    /**
     * The first condition of the approval gate that this threshold does not meet for the answer of an evaluator, or {@link ReviewReason#NONE} when all are met.
     * The conditions and their order are those of 2.x: model, question version, basis, label, probability (command-automation.mjs:88-96). Only
     * {@link ReviewReason#NONE} lets a command run without the owner.
     */
    ReviewReason review(String evaluatorModel, SafetyAssessment.Assessed assessment);
}
