package io.github.jaeseongs95.portal.ssh.hostkey;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.Base64;
import java.util.HexFormat;

import org.apache.sshd.common.config.keys.KeyUtils;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;

/** The fingerprint of a host key and the pin that is compared with it (vendor CR-18, CR-19; cases VR-436 and VR-437 of vendor-ssh-mcp-rules.md, section 5.6). */
class HostKeyFingerprintTest {

    @Test
    @DisplayName("VR-436: the fingerprint of an empty key is the SHA-256 of nothing, SHA256: and Base64 without padding")
    void theFingerprintOfNothing() {
        assertThat(HostKeyFingerprint.ofBlob(new byte[0]).text()).isEqualTo("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
    }

    @Test
    @DisplayName("VR-437: the Base64 of the digest has at most two = characters removed and the prefix is SHA256:")
    void thePaddingIsRemoved() {
        // The SHA-256 of "abc" (FIPS 180-4 example), as hex; its Base64 text is ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0= with one padding character.
        byte[] digest = HexFormat.of().parseHex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThat(Base64.getEncoder().encodeToString(digest)).endsWith("=");

        HostKeyFingerprint fingerprint = HostKeyFingerprint.ofBlob("abc".getBytes(StandardCharsets.UTF_8));

        assertThat(fingerprint.text()).isEqualTo("SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)).doesNotContain("=").startsWith("SHA256:ungWv48Bz");
    }

    @Test
    @DisplayName("VR-437: the fingerprint of a public key is the one MINA and ssh-keygen print")
    void theFingerprintOfAKeyIsTheOneOfOpenSsh() {
        KeyPair key = EmbeddedSshServer.newKeyPair();

        assertThat(HostKeyFingerprint.of(key.getPublic()).text()).isEqualTo(KeyUtils.getFingerPrint(key.getPublic()));
    }

    @Test
    @DisplayName("VR-436, VR-437: two keys have two fingerprints")
    void twoKeysTwoFingerprints() {
        assertThat(HostKeyFingerprint.of(EmbeddedSshServer.newKeyPair().getPublic())).isNotEqualTo(HostKeyFingerprint.of(EmbeddedSshServer.newKeyPair().getPublic()));
    }

    @Test
    @DisplayName("VR-438: the pin accepts the key with its fingerprint, with blanks around the pin removed, and no other key")
    void aPinAcceptsItsKeyOnly() {
        KeyPair pinned = EmbeddedSshServer.newKeyPair();
        KeyPair other = EmbeddedSshServer.newKeyPair();
        PinnedFingerprintVerifier verifier = new PinnedFingerprintVerifier("  " + HostKeyFingerprint.of(pinned.getPublic()).text() + "  ");

        assertThat(verifier.matches(pinned.getPublic())).isTrue();
        assertThat(verifier.matches(other.getPublic())).isFalse();
        assertThat(verifier.pin()).isEqualTo(HostKeyFingerprint.of(pinned.getPublic()).text());
    }

    @Test
    @DisplayName("VR-443 (2.x와 다름: 2.x took an empty pin for no pin, which silently turns pinning off): a blank pin is refused as a configuration error")
    void aBlankPinIsRefused() {
        assertThatThrownBy(() -> new PinnedFingerprintVerifier("")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PinnedFingerprintVerifier("   ")).isInstanceOf(IllegalArgumentException.class);
    }
}
