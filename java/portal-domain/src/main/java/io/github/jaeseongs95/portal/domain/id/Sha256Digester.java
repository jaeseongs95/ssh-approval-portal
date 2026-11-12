package io.github.jaeseongs95.portal.domain.id;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;

/**
 * The SHA-256 implementation of {@link Digester}. A {@link MessageDigest} is not thread safe, so every call takes its own instance (Principles 3.7); the object
 * itself has no state and one instance serves every thread. It is a plain class because portal-domain cannot carry Spring annotations (rule A-DOMAIN); the
 * portal-app configuration registers it as a bean.
 */
public final class Sha256Digester implements Digester {

    private static final String ALGORITHM = "SHA-256";

    @Override
    public Digest digest(byte[] data) {
        Objects.requireNonNull(data, "data");
        try {
            return Digest.of(MessageDigest.getInstance(ALGORITHM).digest(data));
        } catch (NoSuchAlgorithmException e) {
            // Every Java platform implements SHA-256 (MessageDigest API: "Every implementation of the Java platform is required to support"), so this is a broken runtime.
            throw new IllegalStateException(ALGORITHM + " is required of every Java platform", e);
        }
    }
}
