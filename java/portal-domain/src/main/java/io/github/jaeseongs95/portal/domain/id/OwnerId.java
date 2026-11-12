package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.regex.Pattern;

/** The identity that owns an operation or a staged file: 1 to 512 characters without a control character (2.x artifacts.mjs:16). */
public record OwnerId(String value) {

    private static final Pattern SHAPE = Pattern.compile("[^\\x00-\\x1f\\x7f]{1,512}");

    public OwnerId {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("An owner id is 1 to 512 characters without a control character");
        }
    }
}
