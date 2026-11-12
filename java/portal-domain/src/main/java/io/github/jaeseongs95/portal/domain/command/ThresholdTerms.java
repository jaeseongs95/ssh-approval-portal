package io.github.jaeseongs95.portal.domain.command;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * What every threshold states: the model it was validated for, the version of the question, the lowest {@code low_risk} probability that counts as low risk and
 * the reference to the validation that justifies the number (command-policy.mjs:62-69). The probability must be above 0.5 and at most 1: a value at or below one
 * half would let a coin flip approve a command.
 */
public record ThresholdTerms(String model, QuestionVersion questionVersion, double minLowRisk, String validationRef) {

    private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9_.:-]{1,100}");
    private static final Pattern VALIDATION_REF = Pattern.compile("[A-Za-z0-9_.:/-]{1,200}");

    public ThresholdTerms {
        Objects.requireNonNull(model, "model");
        Objects.requireNonNull(questionVersion, "questionVersion");
        Objects.requireNonNull(validationRef, "validationRef");
        if (!MODEL.matcher(model).matches()) {
            throw new IllegalArgumentException("A threshold model is 1 to 100 characters of A-Z a-z 0-9 _ . : -");
        }
        if (!isAboveHalf(minLowRisk)) {
            throw new IllegalArgumentException("A threshold probability is above 0.5 and at most 1");
        }
        if (!VALIDATION_REF.matcher(validationRef).matches()) {
            throw new IllegalArgumentException("A validation reference is 1 to 200 characters of A-Z a-z 0-9 _ . : / -");
        }
    }

    /** True for a finite number above 0.5 and at most 1. */
    public static boolean isAboveHalf(double value) {
        return Double.isFinite(value) && value > 0.5 && value <= 1;
    }

    /** True when the model the evaluator runs is the one this threshold was validated for. */
    public boolean modelMatches(String evaluatorModel) {
        return model.equals(evaluatorModel);
    }
}
