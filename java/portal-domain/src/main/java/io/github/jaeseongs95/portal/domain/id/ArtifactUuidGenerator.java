package io.github.jaeseongs95.portal.domain.id;

import java.nio.ByteBuffer;
import java.util.Objects;
import java.util.UUID;
import java.util.random.RandomGenerator;

/** Makes the public identifiers of staged files: version 4 UUIDs built from the injected generator (RFC 4122 section 4.4), so a test can seed them. */
public final class ArtifactUuidGenerator {

    private static final int UUID_BYTES = 16;
    private static final int VERSION_BYTE = 6;
    private static final int VARIANT_BYTE = 8;

    private final RandomGenerator random;

    public ArtifactUuidGenerator(RandomGenerator random) {
        this.random = Objects.requireNonNull(random, "random");
    }

    public ArtifactUuid next() {
        byte[] bytes = new byte[UUID_BYTES];
        random.nextBytes(bytes);
        bytes[VERSION_BYTE] = (byte) ((bytes[VERSION_BYTE] & 0x0f) | 0x40);
        bytes[VARIANT_BYTE] = (byte) ((bytes[VARIANT_BYTE] & 0x3f) | 0x80);
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        return new ArtifactUuid(new UUID(buffer.getLong(), buffer.getLong()));
    }
}
