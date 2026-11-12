package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Which condition of the model approval gate failed first, in the order the gate checks them (command-automation.mjs:91-96). An explanation only: it never
 * changes what is allowed. {@link #NONE} means the gate passed or was not reached.
 */
public enum ReviewReason {
    NONE("none"),
    EXECUTION_DISABLED("execution_disabled"),
    THRESHOLD_MISSING("threshold_missing"),
    MODEL_MISMATCH("model_mismatch"),
    QUESTION_MISMATCH("question_mismatch"),
    BASIS_MISMATCH("basis_mismatch"),
    /** The evaluator answered {@code high_risk}; the wire value is the label itself. */
    HIGH_RISK("high_risk"),
    BELOW_THRESHOLD("below_threshold");

    private final String wire;

    ReviewReason(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
