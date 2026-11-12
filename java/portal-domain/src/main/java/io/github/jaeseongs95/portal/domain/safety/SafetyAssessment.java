package io.github.jaeseongs95.portal.domain.safety;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The neutral result of one safety evaluation, whatever provider produced it: an assessment that passed every check, or a failure from the closed vocabulary.
 * A raw provider response never reaches this type; the adapter checks it with {@link Assessed#check} and keeps only fixed values (safety.mjs:29-40, 83-86).
 * A value of this type confers no execution authority.
 */
public sealed interface SafetyAssessment permits SafetyAssessment.Assessed, SafetyAssessment.Unavailable {

    /**
     * A valid answer. The invariants are the acceptance rules of 2.x ({@code validateAssessment}): both probabilities and the confidence are in [0, 1], the two
     * probabilities add up to 1 within 1e-6 and no label is more probable than the chosen one.
     *
     * @param model the model that answered; only the characters a threshold may name
     */
    record Assessed(String model, SafetyLabel label, Probability confidence, LabelProbabilities probabilities, UsageNote usage) implements SafetyAssessment {

        private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9_.:-]{1,100}");
        private static final Pattern JEV_MODEL = Pattern.compile("jev-[1-9][0-9]?\\.[0-9]{1,2}\\.[0-9]{1,2}");

        public Assessed {
            Objects.requireNonNull(model, "model");
            Objects.requireNonNull(label, "label");
            Objects.requireNonNull(confidence, "confidence");
            Objects.requireNonNull(probabilities, "probabilities");
            Objects.requireNonNull(usage, "usage");
            if (!MODEL.matcher(model).matches()) {
                throw new IllegalArgumentException("A model name is 1 to 100 characters of A-Z a-z 0-9 _ . : -");
            }
            if (!probabilities.isMostProbable(label)) {
                throw new IllegalArgumentException("The chosen label is not the most probable one");
            }
        }

        /** True when the model that answered is the one the caller asked (command-policy.mjs:86-96 compares the name only, without a format rule). */
        public boolean matchesModel(String expected) {
            return model.equals(expected);
        }

        /** The probability of the {@code low_risk} label. */
        public Probability lowRisk() {
            return probabilities.lowRisk();
        }

        /**
         * A candidate for later automatic use: {@code low_risk}, its probability at least 0.999 and the confidence at least 0.99 (safety.mjs:42-47). Observation only;
         * a candidate is not an approval.
         */
        public boolean isCandidate() {
            return label == SafetyLabel.LOW_RISK && probabilities.lowRisk().value() >= SafetyProtocol.CURRENT.candidateProbability()
                && confidence.value() >= SafetyProtocol.CURRENT.candidateConfidence();
        }

        /**
         * Checks the raw numbers of a provider answer against the acceptance rules and answers the value or the first violated rule, in the order of 2.x
         * {@code assessmentDiagnostic}: model, confidence range, probability range, probability sum, chosen label not the most probable. The label is already a
         * {@link SafetyLabel}; a third label or a missing key is refused where the provider text is read (diagnostics {@code LABEL_DOMAIN}, {@code PROBABILITY_KEYS}).
         */
        public static AssessmentCheck check(String expectedModel, String model, SafetyLabel label, double confidence, double lowRisk, double highRisk, UsageNote usage) {
            if (!Objects.equals(expectedModel, model)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.MODEL_MISMATCH);
            }
            if (!Probability.isValid(confidence)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.CONFIDENCE_RANGE);
            }
            if (!Probability.isValid(lowRisk) || !Probability.isValid(highRisk)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.PROBABILITY_RANGE);
            }
            if (!LabelProbabilities.sumsToOne(lowRisk, highRisk)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.PROBABILITY_SUM);
            }
            LabelProbabilities probabilities = new LabelProbabilities(new Probability(lowRisk), new Probability(highRisk));
            if (!probabilities.isMostProbable(label)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.CHOICE_NOT_MAX);
            }
            return new AssessmentCheck.Accepted(new Assessed(model, label, new Probability(confidence), probabilities, usage));
        }

        /**
         * The observation path ({@code validateAssessment}): the expected model must itself be a Jev model name ({@code jev-N.NN.NN}) and the answer must carry
         * non-negative token counts. The approval path ({@link #check}) has neither rule.
         */
        public static AssessmentCheck checkObservation(String expectedModel, String model, SafetyLabel label, double confidence, double lowRisk, double highRisk,
                                                       long inputTokens, long outputTokens) {
            if (!JEV_MODEL.matcher(expectedModel).matches() || !expectedModel.equals(model)) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.MODEL_MISMATCH);
            }
            AssessmentCheck numbers = check(expectedModel, model, label, confidence, lowRisk, highRisk, new UsageNote.NotReported());
            if (numbers instanceof AssessmentCheck.Rejected) {
                return numbers;
            }
            boolean validCounts = inputTokens >= 0 && inputTokens <= UsageNote.MAX_COUNT && outputTokens >= 0 && outputTokens <= UsageNote.MAX_COUNT;
            if (!validCounts) {
                return new AssessmentCheck.Rejected(SafetyDiagnostic.USAGE_SCHEMA);
            }
            return check(expectedModel, model, label, confidence, lowRisk, highRisk, new UsageNote.Reported(inputTokens, outputTokens));
        }
    }

    /** No assessment: the failure from the closed vocabulary and, when the adapter knows it, the diagnostic that explains an invalid response. */
    record Unavailable(SafetyFailure reason, DiagnosticNote diagnostic) implements SafetyAssessment {

        public Unavailable {
            Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(diagnostic, "diagnostic");
        }

        /**
         * Rebuilds a failure at a provider boundary (safety.mjs:83-86 {@code safetyFailureDetails}). Only fixed vocabulary survives: anything that is not an
         * {@code unavailable} status with a known reason becomes {@code invalid_response}, and a diagnostic outside the vocabulary is dropped. Provider text is
         * never retained.
         */
        public static Unavailable fromProvider(String status, String reason, String diagnostic) {
            if (!"unavailable".equals(status)) {
                return new Unavailable(SafetyFailure.INVALID_RESPONSE, new DiagnosticNote.NoDiagnostic());
            }
            for (SafetyFailure failure : SafetyFailure.values()) {
                if (failure.wire().equals(reason)) {
                    return new Unavailable(failure, DiagnosticNote.of(diagnostic));
                }
            }
            return new Unavailable(SafetyFailure.INVALID_RESPONSE, new DiagnosticNote.NoDiagnostic());
        }
    }

    /** What {@link Assessed#check} answers: the value, or the rule the answer broke. */
    sealed interface AssessmentCheck permits AssessmentCheck.Accepted, AssessmentCheck.Rejected {

        record Accepted(Assessed assessment) implements AssessmentCheck {
            public Accepted {
                Objects.requireNonNull(assessment, "assessment");
            }
        }

        record Rejected(SafetyDiagnostic diagnostic) implements AssessmentCheck {
            public Rejected {
                Objects.requireNonNull(diagnostic, "diagnostic");
            }
        }
    }

    /** The explanation of an invalid response, or none. */
    sealed interface DiagnosticNote permits DiagnosticNote.NoDiagnostic, DiagnosticNote.Diagnosed {

        /** The note for a diagnostic name from a provider boundary: the diagnostic when the name is in the vocabulary, otherwise none. */
        static DiagnosticNote of(String name) {
            for (SafetyDiagnostic diagnostic : SafetyDiagnostic.values()) {
                if (diagnostic.name().equals(name)) {
                    return new Diagnosed(diagnostic);
                }
            }
            return new NoDiagnostic();
        }

        record NoDiagnostic() implements DiagnosticNote {
        }

        record Diagnosed(SafetyDiagnostic diagnostic) implements DiagnosticNote {
            public Diagnosed {
                Objects.requireNonNull(diagnostic, "diagnostic");
            }
        }
    }
}
