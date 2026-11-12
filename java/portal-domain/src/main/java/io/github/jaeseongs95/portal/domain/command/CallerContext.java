package io.github.jaeseongs95.portal.domain.command;

import io.github.jaeseongs95.portal.domain.contract.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.contract.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The caller's own description of why a command is run and what it is for. It is a claim: it is shown to the evaluator and to the owner, labelled as not
 * verified, and it never grants anything. It may be empty. It is refused when it is not text, when it is too long, or when it holds credential material, so
 * that a secret never travels into a request, a log or a model prompt (execution-context.mjs:40-45).
 *
 * <p>The refusal is a contract answer, not a programming error: {@code INVALID_COMMAND_CONTEXT} for text with a NUL character or a lone surrogate (the text
 * cannot be written as UTF-8), {@code COMMAND_CONTEXT_TOO_LARGE} above {@value #MAX_CHARS} characters (UTF-16 units, so 8192 Hangul syllables fit),
 * {@code COMMAND_CONTEXT_CONTAINS_SECRET} for credential material.
 */
public record CallerContext(String value) {

    /** The longest description in UTF-16 characters (execution-context.mjs:4). */
    public static final int MAX_CHARS = 8192;

    public CallerContext {
        if (value == null || value.indexOf('\0') >= 0 || !Utf8Text.isWellFormed(value)) {
            throw new RequestRefusedException(RequestErrorCode.INVALID_COMMAND_CONTEXT);
        }
        if (value.length() > MAX_CHARS) {
            throw new RequestRefusedException(RequestErrorCode.COMMAND_CONTEXT_TOO_LARGE);
        }
        if (new SensitiveText(value).containsCredential()) {
            throw new RequestRefusedException(RequestErrorCode.COMMAND_CONTEXT_CONTAINS_SECRET);
        }
    }

    /** No description. A request without context cannot be sent to a model evaluator. */
    public static CallerContext none() {
        return new CallerContext("");
    }

    /** True when there is nothing to read: empty, or only white space (JavaScript {@code trim}, as 2.x {@code !context.trim()}). */
    public boolean isBlank() {
        return new Utf8Text(value).isBlank();
    }
}
