package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;

/** The risk evaluators a rule can name by their threshold: the primary one and the two fallbacks (command-policy.mjs:50-52). The wire value is the lowercase name. */
public enum EvaluatorProvider {
    JEV("jev"),
    LUNA("luna"),
    SONNET("sonnet");

    private final String wire;

    EvaluatorProvider(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }
}
