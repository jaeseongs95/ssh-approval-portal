package io.github.jaeseongs95.portal.domain.id;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * Computes the digest of a byte sequence. A value that needs a hash (a target revision, an operation contract) receives a {@code Digester}, so the domain has no
 * static hashing helper and a test can supply its own (stage 2 design 4.2, decision D-17).
 */
public interface Digester {

    Digest digest(byte[] data);

    /** The digest of the UTF-8 bytes of the text. */
    default Digest digestUtf8(String text) {
        Objects.requireNonNull(text, "text");
        return digest(text.getBytes(StandardCharsets.UTF_8));
    }
}
