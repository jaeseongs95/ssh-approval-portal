package io.github.jaeseongs95.portal.domain.target;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The name of a connection profile: a letter, digit or underscore, then up to 79 of {@code A-Z a-z 0-9 _ . + -} (2.x command-policy.mjs:14). It names a profile of
 * the SSH profile registry; the administrator's own target settings use the narrower lowercase alias that {@link Target} adds on top of this.
 */
public record ProfileAlias(String value) {

    private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}");

    public ProfileAlias {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("A profile name starts with a letter, digit or underscore and has at most 80 characters of A-Z a-z 0-9 _ . + -");
        }
    }
}
