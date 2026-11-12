package io.github.jaeseongs95.portal.domain.file;

import java.util.Objects;
import java.util.regex.Pattern;

/** The name of a transferred file, not a path: 1 to 255 characters without a control character, a slash or a backslash (2.x artifacts.mjs:36-37). */
public record FileName(String value) {

    private static final Pattern SHAPE = Pattern.compile("[^\\x00-\\x1f\\x7f/\\\\]{1,255}");

    public FileName {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("A file name is 1 to 255 characters without a control character, a slash or a backslash");
        }
    }
}
