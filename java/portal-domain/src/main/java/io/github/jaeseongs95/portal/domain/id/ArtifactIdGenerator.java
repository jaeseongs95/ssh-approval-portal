package io.github.jaeseongs95.portal.domain.id;

import java.util.HexFormat;
import java.util.Objects;
import java.util.random.RandomGenerator;

/** Makes artifact ids: 24 random bytes as 48 lowercase hex characters (2.x artifacts.mjs). */
public final class ArtifactIdGenerator {

    private static final int RANDOM_BYTES = 24;

    private final RandomGenerator random;

    public ArtifactIdGenerator(RandomGenerator random) {
        this.random = Objects.requireNonNull(random, "random");
    }

    public ArtifactId next() {
        byte[] bytes = new byte[RANDOM_BYTES];
        random.nextBytes(bytes);
        return new ArtifactId(HexFormat.of().formatHex(bytes));
    }
}
