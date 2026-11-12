package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.regex.Pattern;

/**
 * The key a caller gives to make a request repeatable (the contract's {@code operationKey}): 16 to 128 characters of {@code A-Z a-z 0-9 _ . : -}. The whole
 * text must match; a regular expression that ends with a dollar sign would let a final line break through (2.x public-contract.mjs:10-11).
 */
public record RequestKey(String value) {

    private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_.:-]{16,128}");

    public RequestKey {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("A request key is 16 to 128 characters of A-Z a-z 0-9 _ . : -");
        }
    }
}
