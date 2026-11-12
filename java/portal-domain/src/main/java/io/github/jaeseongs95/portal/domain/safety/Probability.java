package io.github.jaeseongs95.portal.domain.safety;

/** A number in the closed range from 0 to 1 (safety.mjs:27 {@code unit}); NaN and the infinities are not probabilities. */
public record Probability(double value) {

    public Probability {
        if (!Double.isFinite(value) || value < 0 || value > 1) {
            throw new IllegalArgumentException("A probability is a finite number from 0 to 1");
        }
    }

    /** True when the number is a probability; the same test the constructor applies, for a caller that has a raw number and wants a diagnostic. */
    public static boolean isValid(double candidate) {
        return Double.isFinite(candidate) && candidate >= 0 && candidate <= 1;
    }
}
