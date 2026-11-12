package io.github.jaeseongs95.portal.domain.redact;

import java.util.Objects;

/** A text that went through an {@link OutputRedactor}. The type says that the text is safe to store and to show; a raw string does not. */
public record RedactedText(String value) {

    public RedactedText {
        Objects.requireNonNull(value, "value");
    }
}
