package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.regex.Pattern;

/** The identifier of a transferred file (artifact): the same 48 lowercase hex shape as {@link OperationId}, kept as its own type so the two never mix. */
public record ArtifactId(String value) {

    private static final Pattern SHAPE = Pattern.compile("[a-f0-9]{48}");

    public ArtifactId {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches()) {
            throw new IllegalArgumentException("An artifact id is 48 lowercase hex characters");
        }
    }
}
