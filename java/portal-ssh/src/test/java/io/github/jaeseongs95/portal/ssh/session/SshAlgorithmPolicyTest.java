package io.github.jaeseongs95.portal.ssh.session;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.SshSettings;
import java.nio.file.Path;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.auth.password.PasswordIdentityProvider;
import org.apache.sshd.client.keyverifier.AcceptAllServerKeyVerifier;
import org.apache.sshd.common.keyprovider.KeyIdentityProvider;
import org.apache.sshd.core.CoreModuleProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Cases VR-422 and VR-452 .. VR-455 of vendor-ssh-mcp-rules.md (CR-11, CR-24 .. CR-27): the fixed algorithm lists of 2.x in their order, and the connection options of 2.x
 * (heartbeat every 15 seconds, three unanswered heartbeats) on the MINA client. With BouncyCastle on the class path every name of the lists is offered; a name MINA cannot
 * provide would be left out and named in {@link AlgorithmSelection#unsupported()}.
 */
class SshAlgorithmPolicyTest {

    private final SshAlgorithmPolicy policy = new SshAlgorithmPolicy();

    @Test
    @DisplayName("VR-452 the offer is kex 7, cipher 6, host key 6 and mac 4 names in the order of the 2.x lists, and nothing of the lists is left out")
    void theListsAreOfferedInOrder() {
        AlgorithmSelection selection = policy.selection();
        assertThat(selection.keyExchanges()).containsExactly("curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256", "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
            "diffie-hellman-group16-sha512", "diffie-hellman-group14-sha256");
        assertThat(selection.ciphers()).hasSize(6);
        assertThat(selection.hostKeys()).hasSize(6);
        assertThat(selection.macs()).hasSize(4);
        assertThat(selection.unsupported()).isEmpty();
    }

    @Test
    @DisplayName("VR-453 the ciphers are chacha20-poly1305, aes256-gcm, aes128-gcm, aes256-ctr, aes192-ctr, aes128-ctr in that order")
    void theCipherOrder() {
        assertThat(policy.selection().ciphers()).containsExactly("chacha20-poly1305@openssh.com", "aes256-gcm@openssh.com", "aes128-gcm@openssh.com", "aes256-ctr", "aes192-ctr",
            "aes128-ctr");
    }

    @Test
    @DisplayName("VR-454 the first host key algorithm is ssh-ed25519 and ssh-rsa (SHA-1) is not offered")
    void theHostKeyAlgorithms() {
        assertThat(policy.selection().hostKeys()).startsWith("ssh-ed25519").doesNotContain("ssh-rsa").containsExactly("ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384",
            "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256");
    }

    @Test
    @DisplayName("VR-455 the two etm MACs come first and hmac-sha1 is not offered")
    void theMacs() {
        assertThat(policy.selection().macs()).containsExactly("hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512")
            .doesNotContain("hmac-sha1");
    }

    @Test
    @DisplayName("VR-452 the lists are what the MINA client is set to offer")
    void theClientOffersTheSelection() {
        SshClient client = SshClient.setUpDefaultClient();
        AlgorithmSelection applied = policy.apply(client);
        assertThat(client.getCipherFactoriesNames()).isEqualTo(applied.ciphers());
        assertThat(client.getMacFactoriesNames()).isEqualTo(applied.macs());
        assertThat(client.getKeyExchangeFactories()).extracting(factory -> factory.getName()).isEqualTo(applied.keyExchanges());
    }

    @Test
    @DisplayName("VR-422 the client heartbeats every 15 seconds with keepalive@openssh.com and closes the session after three unanswered ones")
    void theConnectionOptions() {
        MinaClientFactory factory = new MinaClientFactory(SshSettings.defaults(Path.of("known-hosts-not-used-by-the-tests")), policy);
        SshClient client = factory.newClient(AcceptAllServerKeyVerifier.INSTANCE, PasswordIdentityProvider.EMPTY_PASSWORDS_PROVIDER, KeyIdentityProvider.EMPTY_KEYS_PROVIDER);
        try {
            assertThat(CoreModuleProperties.HEARTBEAT_INTERVAL.getRequired(client)).isEqualTo(java.time.Duration.ofSeconds(15));
            assertThat(CoreModuleProperties.HEARTBEAT_NO_REPLY_MAX.getRequired(client)).isEqualTo(3);
            assertThat(CoreModuleProperties.HEARTBEAT_REQUEST.getRequired(client)).isEqualTo("keepalive@openssh.com");
        } finally {
            client.stop();
        }
    }
}
