package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;

/**
 * Everything the approval policy needs to decide one request, given as values so that the decision needs no collaborator: the rule of the target, what the
 * request wants to run, the caller's description, what the model evaluation gave so far, and whether the policy is still the one the evaluation started under.
 */
public record ApprovalInput(RuleLookup rule, ApprovalSubject subject, CallerContext context, EvaluationResult evaluation, PolicyFreshness freshness) {

    public ApprovalInput {
        Objects.requireNonNull(rule, "rule");
        Objects.requireNonNull(subject, "subject");
        Objects.requireNonNull(context, "context");
        Objects.requireNonNull(evaluation, "evaluation");
        Objects.requireNonNull(freshness, "freshness");
    }
}
