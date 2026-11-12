package io.github.jaeseongs95.portal.ssh.pilot;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.IOException;
import java.security.KeyPair;
import java.time.Duration;
import java.util.List;
import java.util.function.Predicate;
import org.apache.sshd.client.ClientBuilder;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.cipher.BuiltinCiphers;
import org.apache.sshd.common.kex.BuiltinDHFactories;
import org.apache.sshd.common.kex.KexProposalOption;
import org.apache.sshd.common.mac.BuiltinMacs;
import org.apache.sshd.common.signature.BuiltinSignatures;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Pilot P3-3 (second half) of docs/migration/stage3-design.md (3.6 "fixed algorithms", 0.3 and A.4): does MINA 2.20.1 offer the algorithms that the 2.x portal fixed
 * (vendor-ssh-mcp-rules.md CR-24 .. CR-27, {@code ssh/algorithms.js:3-31}), in particular {@code curve25519-sha256} and {@code chacha20-poly1305@openssh.com}?
 * The names are looked up in MINA's own {@code Builtin*} registries ({@code fromFactoryName}, {@code isSupported}: the JCE of this JVM must provide the primitive), and one real
 * handshake is made with the client restricted to exactly those two.
 */
@Timeout(60)
class AlgorithmSupportPilotTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";

    /** CR-24 */
    private static final List<String> KEX = List.of("curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
        "diffie-hellman-group16-sha512", "diffie-hellman-group14-sha256");
    /** CR-25 */
    private static final List<String> CIPHERS = List.of("chacha20-poly1305@openssh.com", "aes256-gcm@openssh.com", "aes128-gcm@openssh.com", "aes256-ctr", "aes192-ctr", "aes128-ctr");
    /** CR-26 */
    private static final List<String> HOST_KEYS = List.of("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256");
    /** CR-27 */
    private static final List<String> MACS = List.of("hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512");

    private static List<String> missing(List<String> names, Predicate<String> supported) {
        return names.stream().filter(supported.negate()).toList();
    }

    @Test
    @DisplayName("P3-3 every key exchange name of the 2.x list is a supported MINA 2.20.1 key exchange (curve25519-sha256 included)")
    void theKeyExchangesAreSupported() {
        List<String> unsupported = missing(KEX, name -> {
            BuiltinDHFactories factory = BuiltinDHFactories.fromFactoryName(name);
            return factory != null && factory.isSupported();
        });
        assertThat(unsupported).isEmpty();
    }

    @Test
    @DisplayName("P3-3 every cipher name of the 2.x list is a supported MINA 2.20.1 cipher (chacha20-poly1305@openssh.com included)")
    void theCiphersAreSupported() {
        List<String> unsupported = missing(CIPHERS, name -> {
            BuiltinCiphers cipher = BuiltinCiphers.fromFactoryName(name);
            return cipher != null && cipher.isSupported();
        });
        assertThat(unsupported).isEmpty();
    }

    @Test
    @DisplayName("P3-3 every host key algorithm name of the 2.x list is a supported MINA 2.20.1 signature")
    void theHostKeyAlgorithmsAreSupported() {
        List<String> unsupported = missing(HOST_KEYS, name -> {
            BuiltinSignatures signature = BuiltinSignatures.fromFactoryName(name);
            return signature != null && signature.isSupported();
        });
        assertThat(unsupported).isEmpty();
    }

    @Test
    @DisplayName("P3-3 with BouncyCastle on the class path an ed25519 host key server handshakes and an ed25519 user key logs in (first run: ssh-ed25519 was unsupported without it)")
    void anEd25519ServerAndUserKeyWork() throws IOException {
        KeyPair hostKey = EmbeddedSshServer.newEd25519KeyPair();
        KeyPair userKey = EmbeddedSshServer.newEd25519KeyPair();
        try (EmbeddedSshServer server = EmbeddedSshServer.builder()
            .hostKey(hostKey)
            .publicKey(USER, userKey.getPublic())
            .script("echo hello", ScriptedCommand.exits(0, "hello\n", ""))
            .start();
            SshTestClient client = SshTestClient.startAcceptingAnyHostKey();
            ClientSession session = client.openWithKey(server, USER, userKey)) {
            assertThat(session.getNegotiatedKexParameter(KexProposalOption.SERVERKEYS)).isEqualTo("ssh-ed25519");
            assertThat(session.getServerKey()).isEqualTo(hostKey.getPublic());
            assertThat(client.exec(session, "echo hello", Duration.ofSeconds(10)).stdout()).isEqualTo("hello\n");
        }
    }

    @Test
    @DisplayName("P3-3 every MAC name of the 2.x list is a supported MINA 2.20.1 MAC")
    void theMacsAreSupported() {
        List<String> unsupported = missing(MACS, name -> {
            BuiltinMacs mac = BuiltinMacs.fromFactoryName(name);
            return mac != null && mac.isSupported();
        });
        assertThat(unsupported).isEmpty();
    }

    @Test
    @DisplayName("P3-3 a handshake with the client limited to curve25519-sha256 and chacha20-poly1305@openssh.com negotiates exactly those, and exec works over it")
    void aHandshakeWithTheTwoAlgorithmsSucceeds() throws IOException {
        try (EmbeddedSshServer server = EmbeddedSshServer.builder()
            .password(USER, PASSWORD)
            .script("echo hello", ScriptedCommand.exits(0, "hello\n", ""))
            .customize(mina -> mina.setCipherFactoriesNames("chacha20-poly1305@openssh.com"))
            .start();
            SshTestClient client = SshTestClient.startAcceptingAnyHostKey()) {
            client.sshClient().setKeyExchangeFactories(List.of(ClientBuilder.DH2KEX.apply(BuiltinDHFactories.curve25519)));
            client.sshClient().setCipherFactoriesNames("chacha20-poly1305@openssh.com");
            try (ClientSession session = client.open(server, USER, PASSWORD)) {
                assertThat(session.getNegotiatedKexParameter(KexProposalOption.ALGORITHMS)).isEqualTo("curve25519-sha256");
                assertThat(session.getNegotiatedKexParameter(KexProposalOption.C2SENC)).isEqualTo("chacha20-poly1305@openssh.com");
                assertThat(session.getNegotiatedKexParameter(KexProposalOption.S2CENC)).isEqualTo("chacha20-poly1305@openssh.com");
                assertThat(client.exec(session, "echo hello", Duration.ofSeconds(10)).stdout()).isEqualTo("hello\n");
            }
        }
    }
}
