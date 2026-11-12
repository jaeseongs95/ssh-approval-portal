package io.github.jaeseongs95.portal.domain.text;

/** The source text of a script a caller asks to run: 1 to 16384 UTF-8 bytes and no NUL (2.x ports.mjs PYTHON_SOURCE_MAX_BYTES, execution-context.mjs:36). */
public record SourceText(String value) {

    /** The upper bound of a source text in UTF-8 bytes. */
    public static final int MAX_BYTES = 16384;

    public SourceText {
        Utf8Text text = new Utf8Text(value);
        if (value.isEmpty()) {
            throw new IllegalArgumentException("A source text is not empty");
        }
        if (text.byteLength() > MAX_BYTES) {
            throw new IllegalArgumentException("A source text is at most " + MAX_BYTES + " UTF-8 bytes");
        }
        if (value.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("A source text has no NUL");
        }
    }

    public int byteLength() {
        return new Utf8Text(value).byteLength();
    }
}
