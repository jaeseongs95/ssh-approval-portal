package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.SshSettings;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.auth.password.PasswordIdentityProvider;
import org.apache.sshd.client.config.hosts.HostConfigEntryResolver;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.common.keyprovider.KeyIdentityProvider;
import org.apache.sshd.core.CoreModuleProperties;
import org.springframework.stereotype.Component;

/**
 * Makes the MINA client of one connection, started and set up the way the adapter needs it: the fixed algorithm lists, the heartbeat of 2.x (15 s, three unanswered
 * heartbeats close the session), the host key verifier and the identity providers of the connection, and no file of the machine (no {@code ~/.ssh/config}, no default
 * key). One client per connection: its verifier and identities belong to the hops of that connection, so two connections never share a credential by accident.
 */
@Component
public final class MinaClientFactory {

    /** The request a heartbeat sends: OpenSSH answers it (with failure, which still proves the server is alive), as in 2.x. */
    static final String HEARTBEAT_REQUEST = "keepalive@openssh.com";

    private final SshSettings settings;
    private final SshAlgorithmPolicy algorithms;

    public MinaClientFactory(SshSettings settings, SshAlgorithmPolicy algorithms) {
        this.settings = settings;
        this.algorithms = algorithms;
    }

    /** A started client; the caller stops it when the connection ends. */
    SshClient newClient(ServerKeyVerifier verifier, PasswordIdentityProvider passwords, KeyIdentityProvider keys) {
        SshClient client = SshClient.setUpDefaultClient();
        algorithms.apply(client);
        CoreModuleProperties.HEARTBEAT_REQUEST.set(client, HEARTBEAT_REQUEST);
        CoreModuleProperties.HEARTBEAT_INTERVAL.set(client, settings.heartbeatInterval());
        CoreModuleProperties.HEARTBEAT_NO_REPLY_MAX.set(client, Integer.valueOf(settings.heartbeatNoReplyMax()));
        // The exec reply is asked for per channel (SupervisedExecChannel), not for the whole client.
        client.setServerKeyVerifier(verifier);
        client.setHostConfigEntryResolver(HostConfigEntryResolver.EMPTY);
        client.setPasswordIdentityProvider(passwords);
        client.setKeyIdentityProvider(keys);
        client.start();
        return client;
    }
}
