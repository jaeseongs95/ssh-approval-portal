package io.github.jaeseongs95.portal.domain.target;

import io.github.jaeseongs95.portal.domain.text.Utf8Text;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The name of a target as shown to people: at most 80 characters, not blank, trimmed, and without a control, format, line or paragraph separator character
 * (2.x settings.mjs displayName, targets.mjs:6). {@link #of(String)} takes what the administrator wrote and trims it; the length limit is checked on the text as
 * written, as 2.x did.
 */
public record TargetDisplayName(String value) {

    /** The upper bound in characters. */
    public static final int MAX_LENGTH = 80;

    private static final Pattern FORBIDDEN = Pattern.compile("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]");

    public TargetDisplayName {
        Objects.requireNonNull(value, "value");
        Utf8Text text = new Utf8Text(value);
        if (text.isBlank() || text.hasOuterWhitespace() || value.length() > MAX_LENGTH || FORBIDDEN.matcher(value).find()) {
            throw new IllegalArgumentException("Display names must be at most 80 characters without control or formatting characters");
        }
    }

    /** The display name for the text as written: at most 80 characters before trimming, then trimmed. */
    public static TargetDisplayName of(String written) {
        Utf8Text text = new Utf8Text(written);
        if (written.length() > MAX_LENGTH) {
            throw new IllegalArgumentException("Display names must be at most 80 characters without control or formatting characters");
        }
        return new TargetDisplayName(text.trimmed().value());
    }
}
