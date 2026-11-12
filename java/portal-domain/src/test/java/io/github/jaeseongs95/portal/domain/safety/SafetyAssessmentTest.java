package io.github.jaeseongs95.portal.domain.safety;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** S2-SA-01 and the cases RC-A-861, RC-A-864, RC-A-866 and RC-B-419: what makes a provider answer a valid assessment, and the fixed vocabulary of failures. */
class SafetyAssessmentTest {

    private static final String JEV = "jev-1.14.0";

    @Test
    @DisplayName("RC-A-861 a valid binary answer is accepted: label low_risk, confidence 0.9, probabilities 0.9 and 0.1")
    void validAnswerIsAccepted() {
        SafetyAssessment.AssessmentCheck check = SafetyAssessment.Assessed.checkObservation(JEV, JEV, SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, 5, 2);
        assertThat(check).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        SafetyAssessment.Assessed assessed = ((SafetyAssessment.AssessmentCheck.Accepted) check).assessment();
        assertThat(assessed.label()).isEqualTo(SafetyLabel.LOW_RISK);
        assertThat(assessed.usage()).isEqualTo(new UsageNote.Reported(5, 2));
        assertThat(assessed.matchesModel(JEV)).isTrue();
        assertThat(assessed.matchesModel("jev-9.9.9")).isFalse();
    }

    @Test
    @DisplayName("RC-A-861 / S2-SA-01 probabilities that add up to 1.1 are rejected with PROBABILITY_SUM; the label must be the most probable one (CHOICE_NOT_MAX)")
    void sumAndChoiceAreChecked() {
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 0.9, 0.2)).isEqualTo(rejected(SafetyDiagnostic.PROBABILITY_SUM));
        assertThat(check(SafetyLabel.HIGH_RISK, 0.9, 0.9, 0.1)).isEqualTo(rejected(SafetyDiagnostic.CHOICE_NOT_MAX));
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 0.1, 0.9)).isEqualTo(rejected(SafetyDiagnostic.CHOICE_NOT_MAX));
    }

    @Test
    @DisplayName("S2-SA-01 the sum may differ from 1 by 1e-6 and no more: 1e-6 passes, 1.1e-6 is PROBABILITY_SUM")
    void sumToleranceIsOneMillionth() {
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1 + 0.0000005)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1 + 0.0000011)).isEqualTo(rejected(SafetyDiagnostic.PROBABILITY_SUM));
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1 - 0.0000011)).isEqualTo(rejected(SafetyDiagnostic.PROBABILITY_SUM));
        assertThat(LabelProbabilities.SUM_TOLERANCE).isEqualTo(1e-6);
    }

    @Test
    @DisplayName("RC-A-864 every label, an exact tie and all 101 probability pairs from 0.00 to 1.00 are accepted without a diagnostic")
    void everyValidPairIsAccepted() {
        assertThat(check(SafetyLabel.LOW_RISK, 1, 1, 0)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        assertThat(check(SafetyLabel.HIGH_RISK, 1, 0, 1)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        assertThat(check(SafetyLabel.LOW_RISK, 1, 0.5, 0.5)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        assertThat(check(SafetyLabel.HIGH_RISK, 1, 0.5, 0.5)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        for (int hundredths = 0; hundredths <= 100; hundredths++) {
            double low = hundredths / 100.0;
            double high = (100 - hundredths) / 100.0;
            SafetyLabel label = low >= 0.5 ? SafetyLabel.LOW_RISK : SafetyLabel.HIGH_RISK;
            assertThat(check(label, 1, low, high)).as("%d/100", hundredths).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        }
    }

    @Test
    @DisplayName("RC-B-419 / S2-SA-01 a confidence or probability outside [0, 1], NaN and infinity are rejected: CONFIDENCE_RANGE and PROBABILITY_RANGE")
    void rangesAreChecked() {
        assertThat(check(SafetyLabel.LOW_RISK, Double.NaN, 0.9, 0.1)).isEqualTo(rejected(SafetyDiagnostic.CONFIDENCE_RANGE));
        assertThat(check(SafetyLabel.LOW_RISK, 1.0000001, 0.9, 0.1)).isEqualTo(rejected(SafetyDiagnostic.CONFIDENCE_RANGE));
        assertThat(check(SafetyLabel.LOW_RISK, -0.1, 0.9, 0.1)).isEqualTo(rejected(SafetyDiagnostic.CONFIDENCE_RANGE));
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, Double.POSITIVE_INFINITY, 0.1)).isEqualTo(rejected(SafetyDiagnostic.PROBABILITY_RANGE));
        assertThat(check(SafetyLabel.LOW_RISK, 0.9, 1.5, -0.5)).isEqualTo(rejected(SafetyDiagnostic.PROBABILITY_RANGE));
        assertThatThrownBy(() -> new Probability(Double.NaN)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Probability(1.01)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S2-SA-01 the answer of another model is MODEL_MISMATCH; the observation path also refuses an expected model that is not a Jev name and negative token counts")
    void modelAndUsageAreChecked() {
        assertThat(SafetyAssessment.Assessed.check(JEV, "jev-1.15.0", SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, new UsageNote.NotReported())).isEqualTo(rejected(SafetyDiagnostic.MODEL_MISMATCH));
        assertThat(SafetyAssessment.Assessed.checkObservation("luna", "luna", SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, 1, 1)).isEqualTo(rejected(SafetyDiagnostic.MODEL_MISMATCH));
        assertThat(SafetyAssessment.Assessed.check("luna", "luna", SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, new UsageNote.NotReported())).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        assertThat(SafetyAssessment.Assessed.checkObservation(JEV, JEV, SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, -1, 1)).isEqualTo(rejected(SafetyDiagnostic.USAGE_SCHEMA));
        assertThat(SafetyAssessment.Assessed.checkObservation(JEV, JEV, SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, 1, UsageNote.MAX_COUNT + 1)).isEqualTo(rejected(SafetyDiagnostic.USAGE_SCHEMA));
        assertThat(SafetyAssessment.Assessed.checkObservation(JEV, JEV, SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, 0, UsageNote.MAX_COUNT)).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        for (String bad : List.of("jev-0.1.0", "jev-1.1", "jev-100.1.1", "Jev-1.14.0", "jev-1.14.0 ")) {
            assertThat(SafetyAssessment.Assessed.checkObservation(bad, bad, SafetyLabel.LOW_RISK, 0.9, 0.9, 0.1, 1, 1)).as(bad).isEqualTo(rejected(SafetyDiagnostic.MODEL_MISMATCH));
        }
    }

    @Test
    @DisplayName("RC-B-419 only a valid answer with low_risk, probability at least 0.999 and confidence at least 0.99 is a candidate; the protocol has no execution authority")
    void candidateMatch() {
        assertThat(assessed(SafetyLabel.LOW_RISK, 1.0, 1.0, 0.0).isCandidate()).isTrue();
        assertThat(assessed(SafetyLabel.LOW_RISK, 0.989, 0.999, 0.001).isCandidate()).isFalse();
        assertThat(assessed(SafetyLabel.LOW_RISK, 0.99, 0.999, 0.001).isCandidate()).isTrue();
        assertThat(assessed(SafetyLabel.LOW_RISK, 1.0, 0.998, 0.002).isCandidate()).isFalse();
        assertThat(assessed(SafetyLabel.HIGH_RISK, 1.0, 0.001, 0.999).isCandidate()).isFalse();
        assertThat(check(SafetyLabel.LOW_RISK, Double.NaN, 1.0, 0.0)).isEqualTo(rejected(SafetyDiagnostic.CONFIDENCE_RANGE));
        SafetyProtocol protocol = SafetyProtocol.CURRENT;
        assertThat(protocol.automaticExecutionEnabled()).isFalse();
        assertThat(protocol.thresholdStatus()).isEqualTo("unvalidated");
        assertThat(protocol.version()).isEqualTo("ssh-command-risk-observation-v2");
        assertThat(protocol.adapterRevision()).isEqualTo("typesafe-choice-v1");
        assertThat(protocol.model()).isEqualTo(JEV);
        assertThat(protocol.candidateProbability()).isEqualTo(0.999);
        assertThat(protocol.candidateConfidence()).isEqualTo(0.99);
    }

    @Test
    @DisplayName("S2-SA-01 an assessment that breaks an invariant cannot be built: the label is not the most probable, the model name is malformed")
    void invariantsHoldInTheConstructor() {
        LabelProbabilities mostlyLow = new LabelProbabilities(new Probability(0.9), new Probability(0.1));
        assertThatThrownBy(() -> new SafetyAssessment.Assessed(JEV, SafetyLabel.HIGH_RISK, new Probability(0.9), mostlyLow, new UsageNote.NotReported()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new SafetyAssessment.Assessed("has space", SafetyLabel.LOW_RISK, new Probability(0.9), mostlyLow, new UsageNote.NotReported()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new LabelProbabilities(new Probability(0.9), new Probability(0.2))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new UsageNote.Reported(-1, 0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("RC-A-861 a label outside low_risk and high_risk is not a label: the provider's third label is refused at the boundary")
    void thirdLabelIsRefused() {
        assertThat(SafetyLabel.lookup("low_risk")).isEqualTo(new SafetyLabel.LabelLookup.Known(SafetyLabel.LOW_RISK));
        assertThat(SafetyLabel.lookup("high_risk")).isEqualTo(new SafetyLabel.LabelLookup.Known(SafetyLabel.HIGH_RISK));
        for (String other : List.of("uncertain", "LOW_RISK", "low risk", "")) {
            assertThat(SafetyLabel.lookup(other)).as(other).isInstanceOf(SafetyLabel.LabelLookup.Unknown.class);
        }
        assertThat(SafetyLabel.lookup(null)).isInstanceOf(SafetyLabel.LabelLookup.Unknown.class);
        assertThat(SafetyLabel.values()).extracting(SafetyLabel::wire).containsExactly("low_risk", "high_risk");
    }

    @Test
    @DisplayName("RC-A-866 a failure keeps only the fixed vocabulary: nine failures and seventeen diagnostics, and nothing a provider wrote")
    void failureVocabulary() {
        assertThat(SafetyFailure.values()).extracting(SafetyFailure::wire).containsExactly("not_configured", "busy", "invalid_input", "input_too_large", "timeout", "http_error",
            "invalid_response", "response_too_large", "request_failed");
        assertThat(SafetyDiagnostic.values()).hasSize(17);
        assertThat(SafetyAssessment.Unavailable.fromProvider("unavailable", "invalid_response", "PROBABILITY_SUM"))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.Diagnosed(SafetyDiagnostic.PROBABILITY_SUM)));
        for (SafetyDiagnostic diagnostic : SafetyDiagnostic.values()) {
            assertThat(SafetyAssessment.DiagnosticNote.of(diagnostic.name())).isEqualTo(new SafetyAssessment.DiagnosticNote.Diagnosed(diagnostic));
        }
        for (String other : List.of("probabilitySum", "probability_sum", "", "invalid_response")) {
            assertThat(SafetyAssessment.DiagnosticNote.of(other)).as(other).isInstanceOf(SafetyAssessment.DiagnosticNote.NoDiagnostic.class);
        }
        assertThat(SafetyAssessment.DiagnosticNote.of(null)).isInstanceOf(SafetyAssessment.DiagnosticNote.NoDiagnostic.class);
        assertThat(SafetyAssessment.Unavailable.fromProvider(null, null, null))
            .isEqualTo(new SafetyAssessment.Unavailable(SafetyFailure.INVALID_RESPONSE, new SafetyAssessment.DiagnosticNote.NoDiagnostic()));
    }

    private SafetyAssessment.AssessmentCheck check(SafetyLabel label, double confidence, double low, double high) {
        return SafetyAssessment.Assessed.check(JEV, JEV, label, confidence, low, high, new UsageNote.NotReported());
    }

    private SafetyAssessment.Assessed assessed(SafetyLabel label, double confidence, double low, double high) {
        SafetyAssessment.AssessmentCheck check = check(label, confidence, low, high);
        assertThat(check).isInstanceOf(SafetyAssessment.AssessmentCheck.Accepted.class);
        return ((SafetyAssessment.AssessmentCheck.Accepted) check).assessment();
    }

    private SafetyAssessment.AssessmentCheck rejected(SafetyDiagnostic diagnostic) {
        return new SafetyAssessment.AssessmentCheck.Rejected(diagnostic);
    }
}
