package io.github.jaeseongs95.portal.app.maintenance;

import java.util.Objects;
import java.util.regex.Pattern;

/** The SHA-256 (64 lower-case hex characters) of the secret a maintenance owner holds; only the hash is stored (2.x {@code maintenance-state.mjs:16-19}). */
public record OwnerHash(String value) {

    private static final Pattern FORMAT = Pattern.compile("[a-f0-9]{64}");

    public OwnerHash {
        Objects.requireNonNull(value, "value");
        if (!FORMAT.matcher(value).matches()) {
            throw new IllegalArgumentException("An owner hash is 64 lower-case hex characters");
        }
    }
}
