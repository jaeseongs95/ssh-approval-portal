package io.github.jaeseongs95.portal.domain.classify;

/**
 * The string semantics the vendor classifier takes from JavaScript (ssh-mcp 2.18.0 is JavaScript) and Java does not share (vendor-ssh-mcp-rules.md, risks RK-03
 * and RK-04). White space is the ECMAScript set, not Java's: {@code \s} and {@code String.prototype.trim} accept NBSP and U+FEFF, Java's {@code \s} does not.
 * The characters {@code .} does not match are the four ECMAScript line terminators, Java's {@code .} also leaves out U+0085.
 */
final class ShellText {

    /**
     * The members of a regular expression character class for the ECMAScript white space: TAB, LF, VT, FF, CR, space, U+00A0, U+1680, U+2000-U+200A, U+2028,
     * U+2029, U+202F, U+205F, U+3000, U+FEFF. The escapes are for the regular expression compiler, not for the Java compiler.
     */
    static final String SPACE_CHARS = "\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";

    /** One ECMAScript white space character, as a regular expression. */
    static final String SPACE = "[" + SPACE_CHARS + "]";

    /** The ECMAScript {@code .}: any character except the four line terminators, as a regular expression. */
    static final String ANY_CHAR = "[^\\n\\r\\u2028\\u2029]";

    /** The negation of {@code \w} for ASCII: a regular expression that asserts that no ASCII word character follows. This is the JavaScript {@code \b} after a word character. */
    static final String NO_WORD_AFTER = "(?![A-Za-z0-9_])";

    /** The same before a word character: no ASCII word character precedes. */
    static final String NO_WORD_BEFORE = "(?<![A-Za-z0-9_])";

    boolean isSpace(char c) {
        return switch (c) {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true;
            default -> c >= 0x2000 && c <= 0x200A;
        };
    }

    boolean isLineTerminator(char c) {
        return c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029;
    }

    /** {@code String.prototype.trim}. */
    String trim(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && isSpace(value.charAt(start))) {
            start++;
        }
        while (end > start && isSpace(value.charAt(end - 1))) {
            end--;
        }
        return value.substring(start, end);
    }

    /** True when the word has an ECMAScript white space character ({@code /\s/.test(word)}). */
    boolean containsSpace(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (isSpace(value.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    /** The part of an already trimmed string before its first white space ({@code split(/\s+/)[0]}). */
    String firstToken(String trimmed) {
        int end = 0;
        while (end < trimmed.length() && !isSpace(trimmed.charAt(end))) {
            end++;
        }
        return trimmed.substring(0, end);
    }

    /**
     * Removes one pair of quotes around a word: {@code word.replace(/^(['"])(.*)\1$/, '$2')} (CL-T09). {@code .} does not match a line terminator, so a
     * word that has one between its quotes stays as it is.
     */
    String unquote(String word) {
        int length = word.length();
        if (length < 2) {
            return word;
        }
        char quote = word.charAt(0);
        if (quote != '"' && quote != '\'' || word.charAt(length - 1) != quote) {
            return word;
        }
        for (int i = 1; i < length - 1; i++) {
            if (isLineTerminator(word.charAt(i))) {
                return word;
            }
        }
        return word.substring(1, length - 1);
    }

    /** What follows the last {@code /} or {@code \}: the program name of a path (CL-T10). The case and the extension stay. */
    String stripPath(String word) {
        int cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));
        return cut == -1 ? word : word.substring(cut + 1);
    }
}
