package io.github.jaeseongs95.portal.app.artifact;

/**
 * The staging budget: what is allowed and what the rows charge now. A {@code CONSUMED} row and an empty file charge one byte each (2.x
 * {@code charge = state === 'consumed' ? 1 : Math.max(1, size)}, {@code artifacts.mjs:18}).
 */
public record ArtifactBudget(long budgetBytes, long chargedBytes) {

    public ArtifactBudget {
        if (budgetBytes < 0 || chargedBytes < 0) {
            throw new IllegalArgumentException("The budget and the charge must not be negative");
        }
    }

    public long remainingBytes() {
        return Math.max(0, budgetBytes - chargedBytes);
    }
}
