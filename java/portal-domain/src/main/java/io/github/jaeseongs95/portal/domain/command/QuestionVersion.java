package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * The version of the question a threshold was validated against. The version names the contract between the question and the stored label and probability
 * policy; the wording of the question has its own revision ({@link AutomationQuestion#PROMPT_REVISION}). Only {@link #CURRENT} can authorise execution: a
 * threshold of an older version is read and kept, never used (command-policy.mjs:7, 50).
 */
public enum QuestionVersion {
    V2("ssh-command-risk-v2"),
    V3("ssh-command-risk-v3"),
    V4("ssh-command-risk-v4"),
    V5("ssh-command-risk-v5");

    /** The question version that is in force (command-policy.mjs:7 {@code AUTOMATION_QUESTION_VERSION}). */
    public static final QuestionVersion CURRENT = V5;

    private final String wire;

    QuestionVersion(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** True for the version in force. */
    public boolean isCurrent() {
        return this == CURRENT;
    }
}
