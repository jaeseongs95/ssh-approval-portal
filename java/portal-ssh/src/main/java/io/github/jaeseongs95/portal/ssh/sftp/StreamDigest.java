package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.domain.id.Digest;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;

/**
 * A hash and a byte count that grow while the bytes of a file flow by (the file is never held in memory). One object serves one stream: a
 * {@link MessageDigest} is not thread safe and keeps its state, so a new {@code StreamDigest} is made for every stream, and it is used by the thread that reads the
 * stream. The domain's {@code Digester} hashes a whole {@code byte[]}, which a 64 MiB transfer must not hold.
 */
public final class StreamDigest {

    private final MessageDigest digest;
    private long count;

    private StreamDigest(String algorithm) {
        try {
            this.digest = MessageDigest.getInstance(algorithm);
        } catch (NoSuchAlgorithmException e) {
            // MessageDigest API: every implementation of the Java platform is required to support SHA-256 and SHA-512.
            throw new IllegalStateException(algorithm + " is required of every Java platform", e);
        }
    }

    /** A SHA-256 over an empty stream. */
    public static StreamDigest sha256() {
        return new StreamDigest("SHA-256");
    }

    /** A SHA-512 over an empty stream (the integrity of an npm package is a SHA-512). */
    public static StreamDigest sha512() {
        return new StreamDigest("SHA-512");
    }

    /** Takes the next bytes of the stream. */
    public void update(byte[] bytes, int offset, int length) {
        Objects.requireNonNull(bytes, "bytes");
        digest.update(bytes, offset, length);
        count += length;
    }

    /** The bytes taken so far. */
    public long count() {
        return count;
    }

    /** The SHA-256 of the stream; the object is reset and must not be used for the same stream again. Only for {@link #sha256()}. */
    public Digest finishSha256() {
        return Digest.of(digest.digest());
    }

    /** The raw hash of the stream (any algorithm); the object is reset. */
    public byte[] finish() {
        return digest.digest();
    }
}
