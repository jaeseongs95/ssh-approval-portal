package io.github.jaeseongs95.portal.domain.text;

/**
 * The shell command a caller submits, exactly as written. Shell formatting is visible input, not a reason to change the bytes, so the text is accepted as it is:
 * up to 32768 UTF-8 bytes, not blank, and without a hidden character; only TAB, LF and paired CR LF may appear as layout (2.x validation.mjs:11-12). The text
 * is never trimmed or normalized, because the same command with a different line break is a different command for the digest and for the approval.
 */
public record CommandText(String value) {

    /** The upper bound of a command in UTF-8 bytes (2.x ports.mjs COMMAND_MAX_BYTES). */
    public static final int MAX_BYTES = 32768;

    public CommandText {
        Utf8Text text = new Utf8Text(value);
        if (text.byteLength() > MAX_BYTES) {
            throw new IllegalArgumentException("A command is at most " + MAX_BYTES + " UTF-8 bytes");
        }
        if (text.isBlank()) {
            throw new IllegalArgumentException("A command is not blank");
        }
        if (text.hasHiddenCharactersBesidesLayout()) {
            throw new IllegalArgumentException("A command has a hidden or control character besides TAB, LF and CR LF");
        }
    }

    /** True when the command has more than one line. A classifier that trims its input cannot prove a whole multiline program read only (2.x validation.mjs:20). */
    public boolean isMultiline() {
        return value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0;
    }

    /** The number of bytes of the UTF-8 encoding. */
    public int byteLength() {
        return new Utf8Text(value).byteLength();
    }
}
