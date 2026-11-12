package io.github.jaeseongs95.portal.domain.id;

import java.util.HexFormat;
import java.util.Objects;
import java.util.random.RandomGenerator;

/**
 * Makes operation ids: 24 random bytes as 48 lowercase hex characters (2.x approval-queue.mjs:23). The generator comes from the container as the one
 * {@code SecureRandom} bean; a test passes a seeded generator and gets repeatable ids.
 */
public final class OperationIdGenerator {

    private static final int RANDOM_BYTES = 24;

    private final RandomGenerator random;

    public OperationIdGenerator(RandomGenerator random) {
        this.random = Objects.requireNonNull(random, "random");
    }

    public OperationId next() {
        byte[] bytes = new byte[RANDOM_BYTES];
        random.nextBytes(bytes);
        return new OperationId(HexFormat.of().formatHex(bytes));
    }
}
