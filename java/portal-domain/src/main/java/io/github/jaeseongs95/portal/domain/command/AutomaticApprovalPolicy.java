package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import java.util.List;

/**
 * Decides whether a request runs without the owner, waits for the owner or is refused. It holds no state and asks nobody: the rule, the request, the caller's
 * description and what the model evaluation gave so far are all values in the {@link ApprovalInput}. When only a model can decide and none has been asked yet, the
 * answer is the list of evaluators to ask ({@link ApprovalVerdict.NeedsEvaluation}); the use case asks them and calls this policy again with their answer.
 *
 * <p>The order of the checks is the order of 2.x (command-automation.mjs:134-159), and it is part of the contract: an earlier check wins.
 * <ol>
 *   <li>The rule denies what the request would run, and the test server switch is off: refused ({@code policy_denied}).</li>
 *   <li>The test server switch is on: runs ({@code test_server_bypass}).</li>
 *   <li>The request kind's own screening of the rule: submitted source needs the source contract, sudo and no denied names; a command line that uses sudo needs
 *       the sudo switch; a command whose names are all approved runs ({@code command_set}).</li>
 *   <li>Otherwise a model decides, after these guards, each of which leaves the request to the owner: the owner did not allow disclosure to a model, the caller
 *       gave no description, the command touches secrets, the source evidence is too large.</li>
 *   <li>The model evaluation: no evaluator asked yet (ask), call budget used up, consent withdrawn while it ran, no valid answer, or a valid answer that is
 *       compared with the threshold of that evaluator. A valid answer is final.</li>
 *   <li>A policy that changed since the evaluation started overrides any of the decisions of steps 2 to 5.</li>
 * </ol>
 */
public final class AutomaticApprovalPolicy {

    public ApprovalVerdict decide(ApprovalInput input) {
        RuleLookup lookup = input.rule();
        ApprovalSubject subject = input.subject();
        if (lookup instanceof RuleLookup.Rule found && !found.rule().testServer().isOn() && subject.deniedBy(found.rule())) {
            return decided(ApprovalDecision.byRule(DecisionReason.POLICY_DENIED));
        }
        ApprovalVerdict verdict = verdictWithoutFreshness(input);
        if (verdict instanceof ApprovalVerdict.Decided decided && input.freshness() == PolicyFreshness.CHANGED) {
            ApprovalDecision before = decided.decision();
            return decided(new ApprovalDecision(DecisionReason.POLICY_CHANGED, before.review(), before.model(), before.attempts()));
        }
        return verdict;
    }

    private ApprovalVerdict verdictWithoutFreshness(ApprovalInput input) {
        RuleLookup lookup = input.rule();
        ApprovalSubject subject = input.subject();
        if (lookup instanceof RuleLookup.Rule found && found.rule().testServer().isOn()) {
            return decided(ApprovalDecision.byRule(DecisionReason.TEST_SERVER_BYPASS));
        }
        if (subject.screen(lookup) instanceof ApprovalSubject.Screening.Decided screened) {
            return decided(ApprovalDecision.byRule(screened.reason()));
        }
        if (!(lookup instanceof RuleLookup.Rule found) || !found.rule().externalDisclosure().isOn()) {
            return decided(ApprovalDecision.byRule(DecisionReason.DISCLOSURE_NOT_ENABLED));
        }
        if (input.context().isBlank()) {
            return decided(ApprovalDecision.byRule(DecisionReason.CONTEXT_REQUIRED));
        }
        if (new SensitiveText(subject.command().value()).isSensitive()) {
            return decided(ApprovalDecision.byRule(DecisionReason.SENSITIVE_INPUT));
        }
        if (subject.evidenceTooLarge()) {
            return decided(ApprovalDecision.byRule(DecisionReason.SOURCE_EVIDENCE_TOO_LARGE));
        }
        return switch (input.evaluation()) {
            case EvaluationResult.NotEvaluated notEvaluated -> new ApprovalVerdict.NeedsEvaluation(found.rule().fallback().evaluationOrder());
            case EvaluationResult.BudgetExhausted exhausted -> decided(withAttempts(DecisionReason.BUDGET_EXHAUSTED, exhausted.attempts()));
            case EvaluationResult.ConsentChanged changed -> decided(withAttempts(DecisionReason.POLICY_CHANGED, changed.attempts()));
            case EvaluationResult.NoValidAnswer none -> decided(withAttempts(DecisionReason.EVALUATION_UNAVAILABLE, none.attempts()));
            case EvaluationResult.Answered answered -> decided(compare(found.rule(), answered));
        };
    }

    /** A valid model answer compared with the threshold of the evaluator that gave it (command-automation.mjs:87-102). */
    private ApprovalDecision compare(TargetRule rule, EvaluationResult.Answered answered) {
        ThresholdLookup threshold = rule.thresholds().lookup(answered.provider());
        ModelEvidence evidence = new ModelEvidence.ModelAnswer(answered.provider(), answered.assessment(), threshold);
        if (!rule.modelExecution().isOn()) {
            return new ApprovalDecision(DecisionReason.OBSERVATION_ONLY, ReviewReason.EXECUTION_DISABLED, evidence, answered.attempts());
        }
        return switch (threshold) {
            case ThresholdLookup.NotConfigured missing -> new ApprovalDecision(DecisionReason.OBSERVATION_ONLY, ReviewReason.THRESHOLD_MISSING, evidence, answered.attempts());
            case ThresholdLookup.Configured configured -> {
                ReviewReason review = configured.threshold().review(answered.evaluatorModel(), answered.assessment());
                DecisionReason reason = review == ReviewReason.NONE ? DecisionReason.MODEL_PASSED : DecisionReason.MODEL_REVIEW;
                yield new ApprovalDecision(reason, review, evidence, answered.attempts());
            }
        };
    }

    private static ApprovalDecision withAttempts(DecisionReason reason, List<EvaluationAttempt> attempts) {
        return new ApprovalDecision(reason, ReviewReason.NONE, new ModelEvidence.NoModelAnswer(), attempts);
    }

    private static ApprovalVerdict decided(ApprovalDecision decision) {
        return new ApprovalVerdict.Decided(decision);
    }
}
