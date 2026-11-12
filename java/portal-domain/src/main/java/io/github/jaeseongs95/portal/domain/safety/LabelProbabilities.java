package io.github.jaeseongs95.portal.domain.safety;

import java.util.Objects;

/**
 * The probability of each label. They add up to 1 within 1e-6 (safety.mjs:33, {@code Math.abs(sum - 1) > 1e-6} refuses); the tolerance is the 2.x value and is not
 * widened (defect D-0037).
 */
public record LabelProbabilities(Probability lowRisk, Probability highRisk) {

    /** The largest distance of the sum from 1 that is still accepted. */
    public static final double SUM_TOLERANCE = 1e-6;

    public LabelProbabilities {
        Objects.requireNonNull(lowRisk, "lowRisk");
        Objects.requireNonNull(highRisk, "highRisk");
        if (!sumsToOne(lowRisk.value(), highRisk.value())) {
            throw new IllegalArgumentException("The label probabilities add up to 1 within 1e-6");
        }
    }

    /** True when the two numbers add up to 1 within the tolerance. */
    public static boolean sumsToOne(double lowRisk, double highRisk) {
        return Math.abs(lowRisk + highRisk - 1) <= SUM_TOLERANCE;
    }

    public Probability of(SafetyLabel label) {
        return switch (label) {
            case LOW_RISK -> lowRisk;
            case HIGH_RISK -> highRisk;
        };
    }

    /** True when no label is more probable than the given one. A tie is allowed (0.5 and 0.5 accept either label). */
    public boolean isMostProbable(SafetyLabel label) {
        double chosen = of(label).value();
        return lowRisk.value() <= chosen && highRisk.value() <= chosen;
    }
}
