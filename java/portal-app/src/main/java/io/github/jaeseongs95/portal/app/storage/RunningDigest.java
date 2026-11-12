package io.github.jaeseongs95.portal.app.storage;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;

import io.github.jaeseongs95.portal.domain.id.Digest;

/**
 * A SHA-256 that is fed bytes as they pass, for the transfers that cannot hold a whole file in memory (a file of 64 MiB arrives in pieces). It is one transfer's state,
 * made for that transfer and dropped with it, not a bean; {@link io.github.jaeseongs95.portal.domain.id.Digester} stays the way to hash bytes that are in memory.
 * The algorithm is the same one the {@code Digester} uses.
 */
public final class RunningDigest {

    private static final String ALGORITHM = "SHA-256";

    private final MessageDigest digest;

    public RunningDigest() {
        try {
            this.digest = MessageDigest.getInstance(ALGORITHM);
        } catch (NoSuchAlgorithmException e) {
            // Every Java platform implements SHA-256 (MessageDigest API), so this is a broken runtime.
            throw new IllegalStateException(ALGORITHM + " is required of every Java platform", e);
        }
    }

    /** Adds {@code length} bytes of {@code data} from {@code offset}. */
    public void update(byte[] data, int offset, int length) {
        Objects.requireNonNull(data, "data");
        digest.update(data, offset, length);
    }

    public void update(byte[] data) {
        update(data, 0, data.length);
    }

    /** The digest of everything added so far; the object starts again from nothing. */
    public Digest finish() {
        return Digest.of(digest.digest());
    }
}
