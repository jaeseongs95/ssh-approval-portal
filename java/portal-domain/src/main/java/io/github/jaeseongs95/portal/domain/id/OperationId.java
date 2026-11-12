package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.regex.Pattern;

/** The identifier of an operation: 48 lowercase hex characters, 24 random bytes (2.x validation.mjs:6, public-contract.mjs:7). It is not a UUID. */
public record OperationId(String value) {

    private static final Pattern SHAPE = Pattern.compile("[a-f0-9]{48}");

    public OperationId {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("An operation id is 48 lowercase hex characters");
        }
    }
}
