package io.github.jaeseongs95.portal.domain.id;

import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A fixed-order, length-prefixed text form of a set of named values, the input of a digest that must be the same for the same values (a target revision, an
 * operation contract). Every field is written as {@code name=<UTF-8 length>:<value>} and a line break; the length makes a value that contains a line break or an
 * equals sign unambiguous, and an absent value is written as {@code name=-} so it differs from an empty one. It is not JSON: no library and no key order of a
 * map decides the bytes (stage 2 design 4.5, decision D-09).
 */
public final class CanonicalForm {

    private static final Pattern FIELD_NAME = Pattern.compile("[A-Za-z][A-Za-z0-9.]*");

    private final StringBuilder text = new StringBuilder();

    /** Adds a field with a value. */
    public CanonicalForm field(String name, String value) {
        Objects.requireNonNull(value, "value");
        text.append(checked(name)).append('=').append(value.getBytes(StandardCharsets.UTF_8).length).append(':').append(value).append('\n');
        return this;
    }

    /** Adds a field with a whole number as its value. */
    public CanonicalForm field(String name, long value) {
        return field(name, Long.toString(value));
    }

    /** Adds a field that has no value. */
    public CanonicalForm absent(String name) {
        text.append(checked(name)).append("=-\n");
        return this;
    }

    /** The UTF-8 bytes of the form. */
    public byte[] bytes() {
        return text.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** The digest of the form. */
    public Digest digest(Digester digester) {
        Objects.requireNonNull(digester, "digester");
        return digester.digest(bytes());
    }

    private static String checked(String name) {
        Objects.requireNonNull(name, "name");
        if (!FIELD_NAME.matcher(name).matches()) {
            throw new IllegalArgumentException("A field name is a letter followed by letters, digits and dots");
        }
        return name;
    }
}
