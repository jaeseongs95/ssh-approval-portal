package io.github.jaeseongs95.portal.app.output;

/** The output budget: what is allowed (128 MiB, 1000 outputs) and what the rows charge now. */
public record OutputBudget(long budgetBytes, long chargedBytes, int maxCount, int count) {

    public OutputBudget {
        if (budgetBytes < 0 || chargedBytes < 0 || maxCount < 0 || count < 0) {
            throw new IllegalArgumentException("A budget value must not be negative");
        }
    }
}
