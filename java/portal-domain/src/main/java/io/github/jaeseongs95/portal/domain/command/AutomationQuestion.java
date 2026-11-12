package io.github.jaeseongs95.portal.domain.command;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Objects;

/**
 * The question a model evaluator is asked: the instructions and the two criteria it chooses between. The text is the server's fixed evaluation policy and is
 * sent to the model in English, word for word as in {@code risk/automation-risk-question.json}; it is never translated or rebuilt. Its SHA-256 over the compact
 * JSON of this record (field order {@code type, instructions, criteria}, criteria {@code low_risk, high_risk}) identifies the wording and is recorded with every
 * model decision, separate from the question version ({@link QuestionVersion}).
 */
@JsonPropertyOrder({"type", "instructions", "criteria"})
public record AutomationQuestion(String type, String instructions, Criteria criteria) {

    /** The revision of the wording of the question in force (command-policy.mjs:10). */
    public static final String PROMPT_REVISION = "ssh-command-risk-v5-binary-r1";

    public AutomationQuestion {
        Objects.requireNonNull(type, "type");
        Objects.requireNonNull(instructions, "instructions");
        Objects.requireNonNull(criteria, "criteria");
    }

    /** What each of the two answers means. */
    @JsonPropertyOrder({"low_risk", "high_risk"})
    public record Criteria(@JsonProperty("low_risk") String lowRisk, @JsonProperty("high_risk") String highRisk) {
        public Criteria {
            Objects.requireNonNull(lowRisk, "lowRisk");
            Objects.requireNonNull(highRisk, "highRisk");
        }
    }
}
