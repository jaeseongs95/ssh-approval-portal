package io.github.jaeseongs95.portal.domain.classify;

import java.util.Objects;

/**
 * Why an allow-listed read command was not classified {@code read-only}: the grammar of {@code binary} (the allow-list name, one or two words) did not accept
 * {@code word} (vendor {@code readOnlyRejection}, policy/classifier.js:2181-2186). The empty word is possible (an empty quoted operand).
 */
public record ReadOnlyRejection(String binary, String word) {

    public ReadOnlyRejection {
        Objects.requireNonNull(binary, "binary");
        Objects.requireNonNull(word, "word");
    }
}
