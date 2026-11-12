package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.regex.Pattern;

/** The administrator's name for a target: a lowercase letter and up to 31 of {@code a-z 0-9 _ -} (2.x public-contract.mjs:9, targets.mjs:5). */
public record TargetId(String value) {

    private static final Pattern SHAPE = Pattern.compile("[a-z][a-z0-9_-]{0,31}");

    public TargetId {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("A target id starts with a lowercase letter and has at most 32 characters of a-z 0-9 _ -");
        }
    }
}
