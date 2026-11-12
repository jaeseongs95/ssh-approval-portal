package io.github.jaeseongs95.portal.ssh.hostkey;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.util.Base64;
import java.util.Objects;

import org.apache.sshd.common.util.buffer.ByteArrayBuffer;

/**
 * The fingerprint of a host key in the form of OpenSSH's {@code ssh-keygen -l} and of 2.x (CR-18, vendor ssh/host-key.js:10-15): {@code SHA256:} and the Base64 of the
 * SHA-256 digest of the key in its SSH wire format, without the {@code =} padding. The digest is always SHA-256, whatever default fingerprint factory MINA is given. This is
 * the one place of the product that makes a digest or a Base64 text of a host key.
 *
 * @param text the fingerprint, for example {@code SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU} (the one of an empty key)
 */
public record HostKeyFingerprint(String text) {

    private static final String PREFIX = "SHA256:";

    public HostKeyFingerprint {
        Objects.requireNonNull(text, "text");
    }

    /** The fingerprint of key bytes in the SSH wire format: the blob that a {@code known_hosts} line holds in its Base64 field. */
    public static HostKeyFingerprint ofBlob(byte[] blob) {
        Objects.requireNonNull(blob, "blob");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(blob);
            return new HostKeyFingerprint(PREFIX + Base64.getEncoder().withoutPadding().encodeToString(digest));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("The Java runtime has no SHA-256", e);
        }
    }

    /** The fingerprint of a public key as the server presented it: MINA writes the key in its wire format and the digest is made of that. */
    public static HostKeyFingerprint of(PublicKey key) {
        Objects.requireNonNull(key, "key");
        ByteArrayBuffer wire = new ByteArrayBuffer();
        wire.putRawPublicKey(key);
        return ofBlob(wire.getCompactData());
    }

    @Override
    public String toString() {
        return text;
    }
}
