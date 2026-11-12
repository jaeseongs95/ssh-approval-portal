package io.github.jaeseongs95.portal.domain.id;

import java.util.HexFormat;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * A SHA-256 digest as 64 lowercase hex characters (2.x validation.mjs:5, public-contract.mjs:8). A digest is computed by a {@link Digester}; this type only
 * guarantees the shape.
 */
public record Digest(String hex) {

    private static final Pattern SHAPE = Pattern.compile("[a-f0-9]{64}");
    private static final int RAW_LENGTH = 32;

    public Digest {
        Objects.requireNonNull(hex, "hex");
        if (!SHAPE.matcher(hex).matches()) {
            throw new IllegalArgumentException("A digest is 64 lowercase hex characters");
        }
    }

    /** The digest of the 32 raw bytes a SHA-256 computation returns. */
    public static Digest of(byte[] raw) {
        Objects.requireNonNull(raw, "raw");
        if (raw.length != RAW_LENGTH) {
            throw new IllegalArgumentException("A SHA-256 digest is 32 bytes");
        }
        return new Digest(HexFormat.of().formatHex(raw));
    }
}
