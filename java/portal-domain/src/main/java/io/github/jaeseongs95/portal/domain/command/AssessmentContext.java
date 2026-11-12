package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;

/**
 * The text handed to a model evaluator as its context: the caller's description, the server facts and, for submitted source, the evidence. The size is counted in
 * UTF-16 characters, not bytes: at most {@value #MAX_CHARS}, plus {@link SourceEvidence#MAX_CHARS} when the request carries source (execution-context.mjs:5, 24-38).
 * The text itself is assembled where JSON is written (the adapter), from the value types of this package; this type only holds the result and its limit.
 */
public record AssessmentContext(String text, SourceEvidence evidence) {

    /** The most characters of an assessment context without source evidence. */
    public static final int MAX_CHARS = 12_288;

    public AssessmentContext {
        Objects.requireNonNull(text, "text");
        Objects.requireNonNull(evidence, "evidence");
        if (!Utf8Text.isWellFormed(text)) {
            throw new IllegalArgumentException("The assessment context cannot be written as UTF-8");
        }
        int limit = evidence instanceof SourceEvidence.Submitted ? MAX_CHARS + SourceEvidence.MAX_CHARS : MAX_CHARS;
        if (text.length() > limit) {
            throw new IllegalArgumentException("The assessment context is at most " + limit + " characters");
        }
    }
}
