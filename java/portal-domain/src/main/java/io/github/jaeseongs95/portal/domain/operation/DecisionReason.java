package io.github.jaeseongs95.portal.domain.operation;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.Locale;

/**
 * Why the automatic approval decided as it did: the twenty reason codes of 2.x (command-automation.mjs:134-159). Only {@link #COMMAND_SET}, {@link #MODEL_PASSED}
 * and {@link #TEST_SERVER_BYPASS} start an operation without the owner. The wire value is the lowercase name.
 */
public enum DecisionReason {
    POLICY_DENIED, TEST_SERVER_BYPASS, SOURCE_EXECUTION_NOT_ENABLED, SOURCE_PRIVILEGE_POLICY_REVIEW, SOURCE_COMMAND_POLICY_REVIEW, SUDO_NOT_ENABLED, COMMAND_SET,
    DISCLOSURE_NOT_ENABLED, CONTEXT_REQUIRED, SENSITIVE_INPUT, SOURCE_EVIDENCE_TOO_LARGE, BUDGET_EXHAUSTED, POLICY_CHANGED, EVALUATION_UNAVAILABLE, MODEL_PASSED,
    MODEL_REVIEW, OBSERVATION_ONLY, EVALUATION_FAILED, EXECUTION_BUSY, EXECUTION_START_FAILED;

    /** True for the three reasons under which the server starts an operation by itself. */
    public boolean isAutomatic() {
        return switch (this) {
            case COMMAND_SET, MODEL_PASSED, TEST_SERVER_BYPASS -> true;
            case POLICY_DENIED, SOURCE_EXECUTION_NOT_ENABLED, SOURCE_PRIVILEGE_POLICY_REVIEW, SOURCE_COMMAND_POLICY_REVIEW, SUDO_NOT_ENABLED, DISCLOSURE_NOT_ENABLED,
                CONTEXT_REQUIRED, SENSITIVE_INPUT, SOURCE_EVIDENCE_TOO_LARGE, BUDGET_EXHAUSTED, POLICY_CHANGED, EVALUATION_UNAVAILABLE, MODEL_REVIEW, OBSERVATION_ONLY,
                EVALUATION_FAILED, EXECUTION_BUSY, EXECUTION_START_FAILED -> false;
        };
    }

    @JsonValue
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }
}
