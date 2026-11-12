package io.github.jaeseongs95.portal.domain.redact;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A kind of secret that a regular expression finds (vendor {@code REGEX_PATTERNS}, guard/redactor.js:5-17). Every match, in the whole text, is replaced by
 * {@code [REDACTED:name:length]} where length is the number of UTF-16 code units of the match (the JavaScript {@code length}, RD-08). The match is replaced
 * as a whole; a capture group does not narrow it.
 */
record SecretPattern(String name, Pattern pattern) implements RedactionRule {

    @Override
    public String apply(String text) {
        Matcher matcher = pattern.matcher(text);
        StringBuilder result = null;
        int copiedUpTo = 0;
        while (matcher.find()) {
            if (result == null) {
                result = new StringBuilder(text.length());
            }
            result.append(text, copiedUpTo, matcher.start()).append("[REDACTED:").append(name).append(':').append(matcher.end() - matcher.start()).append(']');
            copiedUpTo = matcher.end();
        }
        if (result == null) {
            return text;
        }
        return result.append(text, copiedUpTo, text.length()).toString();
    }
}
