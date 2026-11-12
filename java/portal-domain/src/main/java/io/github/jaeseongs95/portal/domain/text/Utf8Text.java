package io.github.jaeseongs95.portal.domain.text;

import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Text that can be written as UTF-8: no lone surrogate. It knows the text rules every command, path and context shares: its UTF-8 length, the "hidden" characters
 * that change how text is shown without being visible, and the white space rules of 2.x (a JavaScript {@code trim}, which also removes the no-break space and the
 * byte order mark that {@link String#strip()} keeps).
 */
public record Utf8Text(String value) {

    /** Controls, bidirectional marks, zero width characters, line and paragraph separators, the byte order mark (2.x validation.mjs:4). */
    private static final Pattern HIDDEN = Pattern.compile(
        "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]");
    /** The layout a shell command may contain: paired CR LF, LF and TAB. */
    private static final Pattern LAYOUT = Pattern.compile("\\r\\n|\\n|\\t");

    public Utf8Text {
        Objects.requireNonNull(value, "value");
        if (!isWellFormed(value)) {
            throw new IllegalArgumentException("The text has a lone surrogate and cannot be written as UTF-8");
        }
    }

    /** The number of bytes of the UTF-8 encoding. */
    public int byteLength() {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    /** True when the text is empty or only white space in the JavaScript sense. */
    public boolean isBlank() {
        return value.codePoints().allMatch(Utf8Text::isEcmaWhitespace);
    }

    /** True when the first or the last character is white space in the JavaScript sense. */
    public boolean hasOuterWhitespace() {
        if (value.isEmpty()) {
            return false;
        }
        return isEcmaWhitespace(value.codePointAt(0)) || isEcmaWhitespace(value.codePointBefore(value.length()));
    }

    /** The text without the leading and trailing white space of the JavaScript sense. */
    public Utf8Text trimmed() {
        int start = 0;
        int end = value.length();
        while (start < end && isEcmaWhitespace(value.codePointAt(start))) {
            start += Character.charCount(value.codePointAt(start));
        }
        while (end > start && isEcmaWhitespace(value.codePointBefore(end))) {
            end -= Character.charCount(value.codePointBefore(end));
        }
        return new Utf8Text(value.substring(start, end));
    }

    /** True when any hidden character is present. */
    public boolean hasHiddenCharacters() {
        return HIDDEN.matcher(value).find();
    }

    /** True when a hidden character is present after the layout (paired CR LF, LF, TAB) is taken out. A lone CR is hidden. */
    public boolean hasHiddenCharactersBesidesLayout() {
        return HIDDEN.matcher(LAYOUT.matcher(value).replaceAll("")).find();
    }

    private static boolean isEcmaWhitespace(int codePoint) {
        return codePoint == '\t' || codePoint == '\n' || codePoint == 0x0B || codePoint == 0x0C || codePoint == '\r' || codePoint == 0xFEFF
            || codePoint == 0x2028 || codePoint == 0x2029 || Character.getType(codePoint) == Character.SPACE_SEPARATOR;
    }

    /** True when the text has no lone surrogate, that is, when it can be written as UTF-8. A pure judgement of the argument; no exception is thrown for a bad text. */
    public static boolean isWellFormed(String text) {
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                    i++;
                } else {
                    return false;
                }
            } else if (Character.isLowSurrogate(c)) {
                return false;
            }
        }
        return true;
    }
}
