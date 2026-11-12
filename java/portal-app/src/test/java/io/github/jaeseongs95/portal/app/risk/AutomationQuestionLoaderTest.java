package io.github.jaeseongs95.portal.app.risk;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.domain.command.AutomationQuestion;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

class AutomationQuestionLoaderTest {

    /** The value of 2.x {@code test/jev-prompt-revision.test.mjs:9}: SHA-256 of {@code JSON.stringify(AUTOMATION_QUESTION)}. */
    private static final String PROMPT_SHA256 = "77634c80b0c225777dca0ddc2766db5072b173b7a34e01fdf8e35a48560ac0c5";

    // Boot's JsonMapper bean ignores unknown properties; the test mapper is set the same way.
    private final JsonMapper mapper = JsonMapper.builder().disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

    @Test
    @DisplayName("S2-RE-02: the digest of the compact JSON the loader writes is the 2.x prompt digest")
    void promptDigestIsThe2xValue() {
        AutomationQuestionLoader loader = new AutomationQuestionLoader(mapper, new Sha256Digester());
        assertThat(loader.promptDigest().hex()).isEqualTo(PROMPT_SHA256);
    }

    @Test
    @DisplayName("S2-RE-02: the question has the fixed type and both criteria")
    void questionIsRead() {
        AutomationQuestion question = new AutomationQuestionLoader(mapper, new Sha256Digester()).question();
        assertThat(question.type()).isEqualTo("choice");
        assertThat(question.instructions()).startsWith("You classify the actual security and operational risk");
        assertThat(question.criteria().lowRisk()).startsWith("The supplied evidence establishes bounded, low-impact effects");
        assertThat(question.criteria().highRisk()).startsWith("The invocation has established material security or operational risk");
    }
}
