package io.github.jaeseongs95.portal.domain.classify;

/** A token of an awk program as far as the classifier needs it (vendor {@code {k, v}} tokens, policy/awk.js:190-297). Numbers and regular expressions carry no text. */
record AwkToken(Kind kind, String value) {

    enum Kind {
        NEWLINE,
        STRING,
        REGEX,
        NUMBER,
        WORD,
        PUNCT,
        /** The token before the first one or after the last one: what optional chaining on a missing token gives in the vendor code. */
        NONE
    }

    static final AwkToken NONE = new AwkToken(Kind.NONE, "");
    static final AwkToken NEWLINE = new AwkToken(Kind.NEWLINE, "");
    static final AwkToken REGEX = new AwkToken(Kind.REGEX, "");
    static final AwkToken NUMBER = new AwkToken(Kind.NUMBER, "");

    static AwkToken string(String value) {
        return new AwkToken(Kind.STRING, value);
    }

    static AwkToken word(String value) {
        return new AwkToken(Kind.WORD, value);
    }

    static AwkToken punct(String value) {
        return new AwkToken(Kind.PUNCT, value);
    }

    boolean is(Kind expected) {
        return kind == expected;
    }

    boolean isPunct(String expected) {
        return kind == Kind.PUNCT && expected.equals(value);
    }

    boolean isWord(String expected) {
        return kind == Kind.WORD && expected.equals(value);
    }
}
