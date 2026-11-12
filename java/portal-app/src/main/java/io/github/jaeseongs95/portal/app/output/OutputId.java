package io.github.jaeseongs95.portal.app.output;

import java.util.Objects;
import java.util.regex.Pattern;

/** The id of a stored command output: 48 lower-case hex characters, like every identifier of the contract (2.x {@code idValid}). */
public record OutputId(String value) {

    private static final Pattern FORMAT = Pattern.compile("[a-f0-9]{48}");

    public OutputId {
        Objects.requireNonNull(value, "value");
        if (!FORMAT.matcher(value).matches()) {
            throw new IllegalArgumentException("An output id is 48 lower-case hex characters");
        }
    }
}
