package io.github.jaeseongs95.portal.ssh.realopenssh;

import java.io.IOException;
import java.time.Duration;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.apache.sshd.client.keyverifier.KnownHostsServerKeyVerifier;
import org.apache.sshd.client.keyverifier.RejectAllServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.keyprovider.FileKeyPairProvider;

/**
 * A MINA client logged in to the real OpenSSH server of an {@link OpenSshTarget}: the host key must already be in the known_hosts file of the target (an unknown or changed
 * key is refused, nothing is recorded), the identity is the key file of the target and no other file of the machine is read. The caller closes it.
 */
final class OpenSshClient implements AutoCloseable {

    /** The limit for connecting and authenticating. */
    static final Duration LIMIT = Duration.ofSeconds(30);

    private final SshClient client;
    private final ClientSession session;

    private OpenSshClient(SshClient client, ClientSession session) {
        this.client = client;
        this.session = session;
    }

    static OpenSshClient open(OpenSshTarget target) throws IOException {
        SshClient client = SshClient.setUpDefaultClient();
        client.setServerKeyVerifier(new KnownHostsServerKeyVerifier(RejectAllServerKeyVerifier.INSTANCE, target.knownHosts()));
        client.setHostConfigEntryResolver(HostConfigEntryResolver.EMPTY);
        client.setKeyIdentityProvider(new FileKeyPairProvider(target.keyFile()));
        client.start();
        try {
            ClientSession session = client.connect(target.user(), target.host(), target.port()).verify(LIMIT).getSession();
            session.auth().verify(LIMIT);
            return new OpenSshClient(client, session);
        } catch (IOException | RuntimeException e) {
            client.stop();
            throw e;
        }
    }

    ClientSession session() {
        return session;
    }

    @Override
    public void close() {
        client.stop();
    }
}
