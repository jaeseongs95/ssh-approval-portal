package io.github.jaeseongs95.portal.domain.command;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.domain.operation.DecisionKind;
import io.github.jaeseongs95.portal.domain.operation.DecisionReason;
import io.github.jaeseongs95.portal.domain.safety.LabelProbabilities;
import io.github.jaeseongs95.portal.domain.safety.Probability;
import io.github.jaeseongs95.portal.domain.safety.SafetyAssessment;
import io.github.jaeseongs95.portal.domain.safety.SafetyDiagnostic;
import io.github.jaeseongs95.portal.domain.safety.SafetyFailure;
import io.github.jaeseongs95.portal.domain.safety.SafetyLabel;
import io.github.jaeseongs95.portal.domain.safety.UsageNote;
import io.github.jaeseongs95.portal.domain.text.CommandText;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * S2-PO-02: the fifteen rows of the approval table (stage 2 design 3.5), each decided from values only, plus the cases of 2.x test/command-automation.test.mjs that the
 * decision itself carries (RC-A-419 to RC-A-425, RC-A-432, RC-A-433, RC-A-444, RC-A-448 to RC-A-450). The grammar result is given as a value.
 */
class AutomaticApprovalPolicyTest {

    private static final String JEV = "jev-1.14.0";

    private final AutomaticApprovalPolicy policy = new AutomaticApprovalPolicy();

    // ---- rows 1 to 5: decided by the rule alone ----

    @Test
    @DisplayName("S2-PO-02 row 1 / RC-A-423 a denied name wins over every approval: sudo /bin/rm /tmp/x under a rule that denies rm is denied (kind deny, not automatic)")
    void row1DeniedNameIsRefused() {
        TargetRule rule = RuleFixture.rule().commands("sudo").denied("rm").sudo().build();
        ApprovalDecision decision = decideCommand(rule, "sudo /bin/rm /tmp/x", sudoNames("sudo", "rm"), "context", new EvaluationResult.NotEvaluated());
        assertThat(decision.reason()).isEqualTo(DecisionReason.POLICY_DENIED);
        assertThat(decision.kind()).isEqualTo(DecisionKind.DENY);
        assertThat(decision.isAutomatic()).isFalse();
    }

    @Test
    @DisplayName("S2-PO-02 row 1 / RC-A-433 a name denied after a request was made refuses it when it is decided again")
    void row1NewDenialBindsAnEarlierRequest() {
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        assertThat(decideCommand(RuleFixture.rule().build(), "sudo id", analysis, "", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.SUDO_NOT_ENABLED);
        assertThat(decideCommand(RuleFixture.rule().denied("sudo").build(), "sudo id", analysis, "", new EvaluationResult.NotEvaluated()).reason())
            .isEqualTo(DecisionReason.POLICY_DENIED);
    }

    @Test
    @DisplayName("S2-PO-02 row 1 the test server switch lifts the denial, row 2 it runs the command")
    void row2TestServerBypass() {
        TargetRule rule = RuleFixture.rule().denied("rm").testServer().build();
        ApprovalDecision decision = decideCommand(rule, "rm -rf /tmp/x", complete("rm"), "", new EvaluationResult.NotEvaluated());
        assertThat(decision.reason()).isEqualTo(DecisionReason.TEST_SERVER_BYPASS);
        assertThat(decision.kind()).isEqualTo(DecisionKind.EXECUTE);
        assertThat(decision.isAutomatic()).isTrue();
    }

    @Test
    @DisplayName("S2-PO-02 row 3 submitted source needs the source contract, then the sudo switch, then no denied name; with all three it goes on to the model")
    void row3SubmittedSource() {
        ApprovalSubject.SubmittedSource source = new ApprovalSubject.SubmittedSource(new CommandText("python3 -I -"), complete("python3"), "python3 -I -\nprint(1)\n[]",
            ApprovalSubject.EvidenceSize.WITHIN_LIMIT);
        assertThat(decideSource(RuleFixture.rule().disclosure().build(), source).reason()).isEqualTo(DecisionReason.SOURCE_EXECUTION_NOT_ENABLED);
        assertThat(decideSource(RuleFixture.rule().pythonSource().disclosure().build(), source).reason()).isEqualTo(DecisionReason.SOURCE_PRIVILEGE_POLICY_REVIEW);
        assertThat(decideSource(RuleFixture.rule().pythonSource().sudo().denied("rm").disclosure().build(), source).reason())
            .isEqualTo(DecisionReason.SOURCE_COMMAND_POLICY_REVIEW);
        ApprovalVerdict verdict = policy.decide(new ApprovalInput(new RuleLookup.Rule(RuleFixture.rule().pythonSource().sudo().disclosure().build()), source,
            new CallerContext("why"), new EvaluationResult.NotEvaluated(), PolicyFreshness.CURRENT));
        assertThat(verdict).isInstanceOf(ApprovalVerdict.NeedsEvaluation.class);
    }

    @Test
    @DisplayName("S2-PO-02 row 3 submitted source is never approved by name: no rule is the same as a rule without the contract")
    void row3SourceWithoutRule() {
        ApprovalSubject.SubmittedSource source = new ApprovalSubject.SubmittedSource(new CommandText("python3 -I -"), complete("python3"), "x", ApprovalSubject.EvidenceSize.WITHIN_LIMIT);
        ApprovalVerdict verdict = policy.decide(new ApprovalInput(new RuleLookup.NoRule(), source, new CallerContext("why"), new EvaluationResult.NotEvaluated(),
            PolicyFreshness.CURRENT));
        assertThat(decision(verdict).reason()).isEqualTo(DecisionReason.SOURCE_EXECUTION_NOT_ENABLED);
    }

    @Test
    @DisplayName("S2-PO-02 row 4 / RC-A-444 sudo is an owner decision by default, even when its name is listed; only the automaticSudo switch allows it")
    void row4SudoNeedsItsOwnSwitch() {
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        assertThat(decideCommand(RuleFixture.rule().commands("sudo", "id").build(), "sudo -n id", analysis, "ctx", new EvaluationResult.NotEvaluated()).reason())
            .isEqualTo(DecisionReason.SUDO_NOT_ENABLED);
        assertThat(decideCommand(RuleFixture.rule().commands("id").sudo().build(), "sudo -n id", analysis, "ctx", new EvaluationResult.NotEvaluated()).reason())
            .isEqualTo(DecisionReason.COMMAND_SET);
        ApprovalVerdict model = policy.decide(input(RuleFixture.rule().sudo().disclosure().build(), "sudo -n id", analysis, "ctx", new EvaluationResult.NotEvaluated()));
        assertThat(model).isInstanceOf(ApprovalVerdict.NeedsEvaluation.class);
        assertThat(decideCommand(RuleFixture.rule().commands("id").build(), "sudo -n id", analysis, "ctx", new EvaluationResult.NotEvaluated()).reason())
            .isEqualTo(DecisionReason.SUDO_NOT_ENABLED);
    }

    @Test
    @DisplayName("S2-PO-02 row 5 / RC-A-442 a command whose names are all approved runs by name, without a model and without context")
    void row5CommandSet() {
        TargetRule rule = RuleFixture.rule().commands("ls").disclosure().modelExecution().jevThreshold(0.9).build();
        ApprovalDecision decision = decideCommand(rule, "ls /tmp", complete("ls"), "", new EvaluationResult.NotEvaluated());
        assertThat(decision.reason()).isEqualTo(DecisionReason.COMMAND_SET);
        assertThat(decision.isAutomatic()).isTrue();
        assertThat(decision.model()).isInstanceOf(ModelEvidence.NoModelAnswer.class);
        assertThat(decision.review()).isEqualTo(ReviewReason.NONE);
    }

    @Test
    @DisplayName("S2-PO-02 row 5 one unlisted name, or a line the grammar is not sure of, is not approved by name")
    void row5NeedsEveryNameAndACompleteLine() {
        TargetRule rule = RuleFixture.rule().commands("ls").build();
        assertThat(decideCommand(rule, "ls | rm x", complete("ls", "rm"), "ctx", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.DISCLOSURE_NOT_ENABLED);
        CommandLineAnalysis incomplete = new CommandLineAnalysis(List.of("ls"), Completeness.INCOMPLETE, SudoUse.NO_SUDO);
        assertThat(decideCommand(rule, "ls $(cat x)", incomplete, "ctx", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.DISCLOSURE_NOT_ENABLED);
    }

    @Test
    @DisplayName("S2-PO-02 row 5 on Windows the names are compared in normal form: a listed cmdlet in another letter case is approved")
    void row5Windows() {
        TargetRule rule = RuleFixture.rule().windows().commands("Microsoft.PowerShell.Utility\\Get-Date").build();
        CommandLineAnalysis analysis = new CommandLineAnalysis(List.of("microsoft.powershell.utility\\get-date"), Completeness.COMPLETE, SudoUse.NO_SUDO);
        assertThat(decideCommand(rule, "Microsoft.PowerShell.Utility\\Get-Date", analysis, "", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.COMMAND_SET);
    }

    // ---- rows 6 to 10: the guards before a model is asked ----

    @Test
    @DisplayName("S2-PO-02 row 6 / RC-A-424 with disclosure, context and no secrets the policy asks the evaluators: the primary one, then the fallback")
    void row6AskTheEvaluators() {
        ApprovalSubject.ShellCommand command = shell("rm /tmp/x", complete("rm"));
        TargetRule jevOnly = RuleFixture.rule().disclosure().build();
        TargetRule withLuna = RuleFixture.rule().disclosure().fallback(Fallback.LUNA).build();
        TargetRule withSonnet = RuleFixture.rule().disclosure().fallback(Fallback.SONNET).build();
        assertThat(policy.decide(inputOf(jevOnly, command, "why", new EvaluationResult.NotEvaluated()))).isEqualTo(new ApprovalVerdict.NeedsEvaluation(List.of(EvaluatorProvider.JEV)));
        assertThat(policy.decide(inputOf(withLuna, command, "why", new EvaluationResult.NotEvaluated())))
            .isEqualTo(new ApprovalVerdict.NeedsEvaluation(List.of(EvaluatorProvider.JEV, EvaluatorProvider.LUNA)));
        assertThat(policy.decide(inputOf(withSonnet, command, "why", new EvaluationResult.NotEvaluated())))
            .isEqualTo(new ApprovalVerdict.NeedsEvaluation(List.of(EvaluatorProvider.JEV, EvaluatorProvider.SONNET)));
    }

    @Test
    @DisplayName("S2-PO-02 row 7 / RC-A-423 without the owner's consent to disclosure, or without any rule, nothing goes to a model")
    void row7DisclosureNotEnabled() {
        assertThat(decideCommand(RuleFixture.rule().build(), "rm x", complete("rm"), "why", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.DISCLOSURE_NOT_ENABLED);
        ApprovalVerdict noRule = policy.decide(new ApprovalInput(new RuleLookup.NoRule(), shell("rm x", complete("rm")), new CallerContext("why"), new EvaluationResult.NotEvaluated(),
            PolicyFreshness.CURRENT));
        assertThat(decision(noRule).reason()).isEqualTo(DecisionReason.DISCLOSURE_NOT_ENABLED);
    }

    @Test
    @DisplayName("S2-PO-02 row 8 / RC-A-442 a request without a description, or with only white space, waits for the owner and calls no model")
    void row8ContextRequired() {
        TargetRule rule = RuleFixture.rule().disclosure().sudo().build();
        for (String context : List.of("", "   ", "\t\n")) {
            ApprovalDecision decision = decideCommand(rule, "sudo id", sudoNames("sudo", "id"), context, new EvaluationResult.NotEvaluated());
            assertThat(decision.reason()).as(context).isEqualTo(DecisionReason.CONTEXT_REQUIRED);
            assertThat(decision.model()).isInstanceOf(ModelEvidence.NoModelAnswer.class);
        }
    }

    @Test
    @DisplayName("S2-PO-02 row 9 / RC-A-423 a command that touches secrets is not shown to a model")
    void row9SensitiveInput() {
        TargetRule rule = RuleFixture.rule().disclosure().build();
        assertThat(decideCommand(rule, "cat /etc/shadow", complete("cat"), "why", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.SENSITIVE_INPUT);
        assertThat(decideCommand(rule, "echo password=x", complete("echo"), "why", new EvaluationResult.NotEvaluated()).reason()).isEqualTo(DecisionReason.SENSITIVE_INPUT);
    }

    @Test
    @DisplayName("S2-PO-02 row 10 submitted source whose evidence is too large for the evaluator goes to the owner")
    void row10SourceEvidenceTooLarge() {
        ApprovalSubject.SubmittedSource source = new ApprovalSubject.SubmittedSource(new CommandText("python3 -I -"), complete("python3"), "x", ApprovalSubject.EvidenceSize.TOO_LARGE);
        assertThat(decideSource(RuleFixture.rule().pythonSource().sudo().disclosure().build(), source).reason()).isEqualTo(DecisionReason.SOURCE_EVIDENCE_TOO_LARGE);
    }

    // ---- rows 11 to 13: the evaluation gave no answer ----

    @Test
    @DisplayName("S2-PO-02 row 11 an exhausted call budget leaves the request to the owner")
    void row11BudgetExhausted() {
        ApprovalDecision decision = evaluate(new EvaluationResult.BudgetExhausted(List.of()));
        assertThat(decision.reason()).isEqualTo(DecisionReason.BUDGET_EXHAUSTED);
        assertThat(decision.kind()).isEqualTo(DecisionKind.REVIEW);
    }

    @Test
    @DisplayName("S2-PO-02 row 12 an evaluation that outlived the owner's consent leaves the request to the owner")
    void row12ConsentChanged() {
        assertThat(evaluate(new EvaluationResult.ConsentChanged(List.of())).reason()).isEqualTo(DecisionReason.POLICY_CHANGED);
    }

    @Test
    @DisplayName("S2-PO-02 row 13 / RC-A-449 / RC-A-450 no valid answer: evaluation_unavailable, with the attempts kept as fixed vocabulary and no assessment")
    void row13NoValidAnswerKeepsTheAttempts() {
        SafetyAssessment.Unavailable failure = SafetyAssessment.Unavailable.fromProvider("unavailable", "invalid_response", "PROBABILITY_SUM");
        List<EvaluationAttempt> attempts = List.of(new EvaluationAttempt.Failed(EvaluatorProvider.JEV, failure));
        ApprovalDecision decision = evaluate(new EvaluationResult.NoValidAnswer(attempts));
        assertThat(decision.reason()).isEqualTo(DecisionReason.EVALUATION_UNAVAILABLE);
        assertThat(decision.model()).isInstanceOf(ModelEvidence.NoModelAnswer.class);
        assertThat(decision.isAutomatic()).isFalse();
        assertThat(decision.attempts()).containsExactly(new EvaluationAttempt.Failed(EvaluatorProvider.JEV,
            new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.Diagnosed(SafetyDiagnostic.PROBABILITY_SUM))));
    }

    @Test
    @DisplayName("RC-A-450 a failure rebuilt at the provider boundary keeps fixed vocabulary only: a diagnostic outside the list is dropped, an unknown status becomes invalid_response")
    void failuresKeepFixedVocabularyOnly() {
        assertThat(SafetyAssessment.Unavailable.fromProvider("unavailable", "invalid_response", "raw body of the provider"))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.NoDiagnostic()));
        assertThat(SafetyAssessment.Unavailable.fromProvider("assessed", "timeout", "PROBABILITY_SUM"))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.NoDiagnostic()));
        assertThat(SafetyAssessment.Unavailable.fromProvider("unavailable", "something else", null))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.NoDiagnostic()));
        assertThat(SafetyAssessment.Unavailable.fromProvider("unavailable", "timeout", null))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.TIMEOUT, new SafetyAssessment.DiagnosticNote.NoDiagnostic()));
    }

    // ---- rows 14 and 15: a valid answer against the threshold ----

    @Test
    @DisplayName("S2-PO-02 row 14 / RC-A-419 a low_risk answer at the threshold passes: model_passed runs the command, sudo included when its switch is on")
    void row14ModelPassed() {
        TargetRule rule = RuleFixture.rule().disclosure().modelExecution().sudo().jevThreshold(0.9).build();
        ApprovalDecision decision = decideWith(rule, "sudo systemctl restart synthetic.service", sudoNames("sudo", "systemctl"), answered(0.9, 0.1));
        assertThat(decision.reason()).isEqualTo(DecisionReason.MODEL_PASSED);
        assertThat(decision.isAutomatic()).isTrue();
        assertThat(decision.review()).isEqualTo(ReviewReason.NONE);
        assertThat(decision.model()).isInstanceOf(ModelEvidence.ModelAnswer.class);
    }

    @Test
    @DisplayName("RC-A-420 the boundary 0.9 passes and 0.899 does not; the confidence is a diagnostic, not a second gate (0.1 passes, 0.86 passes)")
    void probabilityBoundaryIsInclusive() {
        TargetRule rule = RuleFixture.rule().disclosure().modelExecution().sudo().jevThreshold(0.9).build();
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        ApprovalDecision below = decideWith(rule, "sudo id", analysis, answered(0.899, 1.0));
        assertThat(below.reason()).isEqualTo(DecisionReason.MODEL_REVIEW);
        assertThat(below.review()).isEqualTo(ReviewReason.BELOW_THRESHOLD);
        assertThat(decideWith(rule, "sudo id", analysis, answered(0.9, 0.1)).reason()).isEqualTo(DecisionReason.MODEL_PASSED);
        assertThat(decideWith(rule, "sudo id", analysis, answered(0.91, 0.86)).reason()).isEqualTo(DecisionReason.MODEL_PASSED);
        ModelEvidence.ModelAnswer evidence = (ModelEvidence.ModelAnswer) decideWith(rule, "sudo id", analysis, answered(0.9, 0.1)).model();
        assertThat(((ThresholdLookup.Configured) evidence.threshold()).threshold()).isInstanceOf(ProbabilityThreshold.class);
    }

    @Test
    @DisplayName("RC-A-422 / S2-PO-02 row 15 the review reason names the first failed condition, in order, and nothing changes what is allowed")
    void row15ReviewReasons() {
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        TargetRule executionOff = RuleFixture.rule().disclosure().sudo().jevThreshold(0.9).build();
        assertThat(reasonFor(executionOff, analysis, answered(1.0, 1.0))).containsExactly(DecisionReason.OBSERVATION_ONLY, ReviewReason.EXECUTION_DISABLED);
        assertThat(reasonFor(RuleFixture.rule().disclosure().sudo().modelExecution().build(), analysis, answered(1.0, 1.0)))
            .containsExactly(DecisionReason.OBSERVATION_ONLY, ReviewReason.THRESHOLD_MISSING);
        TargetRule otherModel = RuleFixture.rule().disclosure().sudo().modelExecution()
            .threshold(EvaluatorProvider.JEV, new ProbabilityThreshold(RuleFixture.terms("jev-9.9.9", QuestionVersion.V5, 0.9))).build();
        assertThat(reasonFor(otherModel, analysis, answered(1.0, 1.0))).containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.MODEL_MISMATCH);
        TargetRule oldQuestion = RuleFixture.rule().disclosure().sudo().modelExecution()
            .threshold(EvaluatorProvider.JEV, new ProbabilityThreshold(RuleFixture.terms(JEV, QuestionVersion.V3, 0.9))).build();
        assertThat(reasonFor(oldQuestion, analysis, answered(1.0, 1.0))).containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.QUESTION_MISMATCH);
        TargetRule current = RuleFixture.rule().disclosure().sudo().modelExecution().jevThreshold(0.9).build();
        assertThat(reasonFor(current, analysis, highRiskAnswer())).containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.HIGH_RISK);
        assertThat(reasonFor(current, analysis, answered(0.8, 1.0))).containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.BELOW_THRESHOLD);
    }

    @Test
    @DisplayName("RC-A-421 a threshold of an older form or version is read and kept but never approves: confidence thresholds, v2, v3 and v4 questions all go to the owner")
    void olderThresholdsNeverApprove() {
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        for (QuestionVersion version : List.of(QuestionVersion.V2, QuestionVersion.V3, QuestionVersion.V4)) {
            ThresholdTerms terms = RuleFixture.terms(JEV, version, 0.9);
            for (Threshold threshold : List.of(new ConfidenceThreshold(terms, 0.9), new ProbabilityThreshold(terms))) {
                TargetRule rule = RuleFixture.rule().disclosure().sudo().modelExecution().threshold(EvaluatorProvider.JEV, threshold).build();
                assertThat(reasonFor(rule, analysis, answered(1.0, 1.0))).as(version + " " + threshold.getClass().getSimpleName())
                    .containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.QUESTION_MISMATCH);
            }
        }
        TargetRule v5Confidence = RuleFixture.rule().disclosure().sudo().modelExecution()
            .threshold(EvaluatorProvider.JEV, new ConfidenceThreshold(RuleFixture.terms(JEV, QuestionVersion.V5, 0.9), 0.99)).build();
        assertThat(reasonFor(v5Confidence, analysis, answered(1.0, 1.0))).containsExactly(DecisionReason.MODEL_REVIEW, ReviewReason.BASIS_MISMATCH);
    }

    @Test
    @DisplayName("RC-A-432 an answer that is not valid (a probability sum of 2, another model) never reaches the gate; the request goes to the owner")
    void invalidAnswersGoToTheOwner() {
        assertThat(SafetyAssessment.Assessed.check(JEV, JEV, SafetyLabel.LOW_RISK, 1.0, 1.0, 1.0, new UsageNote.NotReported())).isInstanceOf(SafetyAssessment.AssessmentCheck.Rejected.class);
        assertThat(SafetyAssessment.Assessed.check(JEV, "jev-9.9.9", SafetyLabel.LOW_RISK, 1.0, 1.0, 0.0, new UsageNote.NotReported()))
            .isEqualTo(new SafetyAssessment.AssessmentCheck.Rejected(SafetyDiagnostic.MODEL_MISMATCH));
        TargetRule rule = RuleFixture.rule().disclosure().sudo().modelExecution().jevThreshold(0.9).build();
        ApprovalDecision decision = decideWithEvaluation(rule, "sudo id", sudoNames("sudo", "id"), new EvaluationResult.NoValidAnswer(List.of()));
        assertThat(decision.kind()).isEqualTo(DecisionKind.REVIEW);
    }

    @Test
    @DisplayName("S2-PO-02 a policy that changed since the evaluation started voids any automatic decision (RC-A-425): the answer is kept, the decision is policy_changed")
    void changedPolicyVoidsTheDecision() {
        TargetRule rule = RuleFixture.rule().disclosure().sudo().modelExecution().jevThreshold(0.9).build();
        CommandLineAnalysis analysis = sudoNames("sudo", "id");
        EvaluationResult.Answered answer = answered(0.99, 1.0, new UsageNote.Reported(17, 3));
        ApprovalVerdict verdict = policy.decide(new ApprovalInput(new RuleLookup.Rule(rule), shell("sudo id", analysis), new CallerContext("why"), answer, PolicyFreshness.CHANGED));
        ApprovalDecision decision = decision(verdict);
        assertThat(decision.reason()).isEqualTo(DecisionReason.POLICY_CHANGED);
        assertThat(decision.kind()).isEqualTo(DecisionKind.REVIEW);
        ModelEvidence.ModelAnswer kept = (ModelEvidence.ModelAnswer) decision.model();
        assertThat(kept.assessment().usage()).isEqualTo(new UsageNote.Reported(17, 3));
        TargetRule listed = RuleFixture.rule().commands("ls").build();
        ApprovalVerdict byName = policy.decide(new ApprovalInput(new RuleLookup.Rule(listed), shell("ls", complete("ls")), CallerContext.none(), new EvaluationResult.NotEvaluated(),
            PolicyFreshness.CHANGED));
        assertThat(decision(byName).reason()).isEqualTo(DecisionReason.POLICY_CHANGED);
    }

    @Test
    @DisplayName("S2-PO-02 a denial is not voided by a changed policy: it is decided before the freshness is looked at")
    void denialBeatsFreshness() {
        TargetRule rule = RuleFixture.rule().denied("rm").build();
        ApprovalVerdict verdict = policy.decide(new ApprovalInput(new RuleLookup.Rule(rule), shell("rm x", complete("rm")), CallerContext.none(), new EvaluationResult.NotEvaluated(),
            PolicyFreshness.CHANGED));
        assertThat(decision(verdict).reason()).isEqualTo(DecisionReason.POLICY_DENIED);
    }

    @Test
    @DisplayName("S2-PO-02 exactly three reasons run a command without the owner and exactly one refuses it")
    void kindsOfTheTwentyReasons() {
        List<DecisionReason> automatic = List.of(DecisionReason.COMMAND_SET, DecisionReason.MODEL_PASSED, DecisionReason.TEST_SERVER_BYPASS);
        for (DecisionReason reason : DecisionReason.values()) {
            ApprovalDecision decision = ApprovalDecision.byRule(reason);
            DecisionKind expected = automatic.contains(reason) ? DecisionKind.EXECUTE : reason == DecisionReason.POLICY_DENIED ? DecisionKind.DENY : DecisionKind.REVIEW;
            assertThat(decision.kind()).as(reason.name()).isEqualTo(expected);
        }
        assertThat(DecisionReason.values()).hasSize(20);
        assertThat(ApprovalDecision.EXPLANATION_RULE_VERSION).isEqualTo("command-explanation-v1");
    }

    // ---- helpers ----

    private ApprovalDecision evaluate(EvaluationResult result) {
        TargetRule rule = RuleFixture.rule().disclosure().build();
        return decideWithEvaluation(rule, "rm /tmp/x", complete("rm"), result);
    }

    private ApprovalDecision decideWithEvaluation(TargetRule rule, String command, CommandLineAnalysis analysis, EvaluationResult result) {
        return decideCommand(rule, command, analysis, "why", result);
    }

    private ApprovalDecision decideWith(TargetRule rule, String command, CommandLineAnalysis analysis, EvaluationResult.Answered answer) {
        return decideCommand(rule, command, analysis, "why", answer);
    }

    private List<Object> reasonFor(TargetRule rule, CommandLineAnalysis analysis, EvaluationResult.Answered answer) {
        ApprovalDecision decision = decideWith(rule, "sudo id", analysis, answer);
        return List.of(decision.reason(), decision.review());
    }

    private ApprovalDecision decideCommand(TargetRule rule, String command, CommandLineAnalysis analysis, String context, EvaluationResult evaluation) {
        return decision(policy.decide(input(rule, command, analysis, context, evaluation)));
    }

    private ApprovalDecision decideSource(TargetRule rule, ApprovalSubject.SubmittedSource source) {
        return decision(policy.decide(inputOf(rule, source, "why", new EvaluationResult.NotEvaluated())));
    }

    private ApprovalInput input(TargetRule rule, String command, CommandLineAnalysis analysis, String context, EvaluationResult evaluation) {
        return inputOf(rule, shell(command, analysis), context, evaluation);
    }

    private ApprovalInput inputOf(TargetRule rule, ApprovalSubject subject, String context, EvaluationResult evaluation) {
        return new ApprovalInput(new RuleLookup.Rule(rule), subject, new CallerContext(context), evaluation, PolicyFreshness.CURRENT);
    }

    private ApprovalSubject.ShellCommand shell(String command, CommandLineAnalysis analysis) {
        return new ApprovalSubject.ShellCommand(new CommandText(command), analysis);
    }

    private ApprovalDecision decision(ApprovalVerdict verdict) {
        assertThat(verdict).isInstanceOf(ApprovalVerdict.Decided.class);
        return ((ApprovalVerdict.Decided) verdict).decision();
    }

    private CommandLineAnalysis complete(String... names) {
        return new CommandLineAnalysis(List.of(names), Completeness.COMPLETE, SudoUse.NO_SUDO);
    }

    private CommandLineAnalysis sudoNames(String... names) {
        return new CommandLineAnalysis(List.of(names), Completeness.COMPLETE, SudoUse.USES_SUDO);
    }

    private EvaluationResult.Answered answered(double lowRisk, double confidence) {
        return answered(lowRisk, confidence, new UsageNote.NotReported());
    }

    private EvaluationResult.Answered answered(double lowRisk, double confidence, UsageNote usage) {
        SafetyAssessment.Assessed assessment = new SafetyAssessment.Assessed(JEV, SafetyLabel.LOW_RISK, new Probability(confidence),
            new LabelProbabilities(new Probability(lowRisk), new Probability(1 - lowRisk)), usage);
        return new EvaluationResult.Answered(EvaluatorProvider.JEV, JEV, assessment, List.of());
    }

    private EvaluationResult.Answered highRiskAnswer() {
        SafetyAssessment.Assessed assessment = new SafetyAssessment.Assessed(JEV, SafetyLabel.HIGH_RISK, new Probability(0.99),
            new LabelProbabilities(new Probability(0.01), new Probability(0.99)), new UsageNote.NotReported());
        return new EvaluationResult.Answered(EvaluatorProvider.JEV, JEV, assessment, List.of());
    }
}
