package io.github.jaeseongs95.portal.ssh.hostkey;

import java.net.SocketAddress;
import java.security.PublicKey;
import java.util.Objects;

import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;

/**
 * Accepts the one host key whose fingerprint is the pin of the profile ({@code trustedHostKey}, CR-19). The pin is written as {@code SHA256:} and the Base64 of the digest
 * without padding, and is compared as text after the surrounding blanks are removed. A pin is never empty: a blank pin is a configuration error, not "no pin"
 * (2.x treated an empty pin as none, which would silently turn pinning off).
 */
public final class PinnedFingerprintVerifier implements ServerKeyVerifier {

    private final String pin;

    /** @throws IllegalArgumentException when the pin is blank */
    public PinnedFingerprintVerifier(String pin) {
        Objects.requireNonNull(pin, "pin");
        if (pin.isBlank()) {
            throw new IllegalArgumentException("A pinned host key is not blank");
        }
        this.pin = pin.strip();
    }

    /** The pin, without the surrounding blanks. */
    public String pin() {
        return pin;
    }

    /** True when the fingerprint of the key is the pin. */
    public boolean matches(PublicKey key) {
        return Objects.equals(HostKeyFingerprint.of(key).text(), pin);
    }

    @Override
    public boolean verifyServerKey(ClientSession session, SocketAddress remoteAddress, PublicKey serverKey) {
        return matches(serverKey);
    }
}
