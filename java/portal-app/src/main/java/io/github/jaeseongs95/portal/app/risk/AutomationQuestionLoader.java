package io.github.jaeseongs95.portal.app.risk;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import io.github.jaeseongs95.portal.domain.command.AutomationQuestion;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import tools.jackson.databind.json.JsonMapper;

/**
 * Reads the automatic-evaluation question from the resource of portal-domain and computes its digest. The domain cannot parse JSON (rule A-DOMAIN), so this
 * module does it with the Boot {@link JsonMapper} (Principles 2.2 category 2). The file is read once at start-up: a missing or damaged resource stops the
 * application instead of failing on the first evaluation.
 *
 * <p>The digest is the SHA-256 of the compact JSON of the record, the same bytes as 2.x {@code JSON.stringify(AUTOMATION_QUESTION)}
 * ({@code command-policy.mjs:12}); the test S2-RE-02 pins the value {@code 77634c80...0ac0c5}. If Jackson wrote different bytes (escaping, key order), the fix is the
 * record's component order, not a mapper setting.
 */
@Component
public class AutomationQuestionLoader {

    static final String RESOURCE = "risk/automation-risk-question.json";

    private final AutomationQuestion question;
    private final Digest promptDigest;

    public AutomationQuestionLoader(JsonMapper mapper, Digester digester) {
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            this.question = mapper.readValue(in, AutomationQuestion.class);
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot read the resource " + RESOURCE, e);
        }
        this.promptDigest = digester.digest(mapper.writeValueAsBytes(question));
    }

    public AutomationQuestion question() {
        return question;
    }

    /** SHA-256 of the compact JSON of {@link #question()}. */
    public Digest promptDigest() {
        return promptDigest;
    }
}
