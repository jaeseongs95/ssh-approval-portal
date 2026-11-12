package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonValue;
import java.util.List;

/**
 * The evaluator a rule falls back to when the primary one cannot answer. It is asked only when the primary evaluator is unavailable; a valid answer, even a
 * risky one, is final and never leads to a second opinion (command-automation.mjs:85, 2.x "never shop for a second opinion").
 */
public enum Fallback {
    NONE("none"),
    LUNA("luna"),
    SONNET("sonnet");

    private final String wire;

    Fallback(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    /** The evaluators in the order they are asked: the primary one, then the fallback when there is one (command-automation.mjs:55). */
    public List<EvaluatorProvider> evaluationOrder() {
        return switch (this) {
            case NONE -> List.of(EvaluatorProvider.JEV);
            case LUNA -> List.of(EvaluatorProvider.JEV, EvaluatorProvider.LUNA);
            case SONNET -> List.of(EvaluatorProvider.JEV, EvaluatorProvider.SONNET);
        };
    }
}
