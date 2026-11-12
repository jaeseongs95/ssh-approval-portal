package io.github.jaeseongs95.portal.domain.id;

import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The public identifier of a staged file: a version 4 UUID with the RFC 4122 variant, written as lowercase canonical text (2.x public-contract.mjs:12). The
 * canonical text is checked by {@link #parse(String)} because {@link UUID#fromString(String)} also accepts short and upper case forms.
 */
public record ArtifactUuid(UUID value) {

    private static final Pattern CANONICAL = Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}");
    private static final int VERSION_4 = 4;
    private static final int RFC_4122_VARIANT = 2;

    public ArtifactUuid {
        Objects.requireNonNull(value, "value");
        if (value.version() != VERSION_4 || value.variant() != RFC_4122_VARIANT) {
            throw new IllegalArgumentException("A staged file uuid is a version 4 UUID");
        }
    }

    /** Reads the lowercase canonical text; anything else is rejected. */
    public static ArtifactUuid parse(String text) {
        Objects.requireNonNull(text, "text");
        if (!CANONICAL.matcher(text).matches()) {
            throw new IllegalArgumentException("A staged file uuid is a lowercase version 4 UUID");
        }
        return new ArtifactUuid(UUID.fromString(text));
    }

    /** The lowercase canonical text. */
    public String text() {
        return value.toString();
    }
}
