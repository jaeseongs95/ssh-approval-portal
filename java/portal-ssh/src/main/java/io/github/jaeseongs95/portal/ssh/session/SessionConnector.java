package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.app.remote.SshSettings;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.ssh.hostkey.ServerKeyPolicy;
import java.io.IOException;
import java.util.List;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.config.hosts.HostConfigEntry;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.session.SessionListener;
import org.springframework.stereotype.Component;

/**
 * Makes one authenticated session to the target of a profile, through the jump hosts of the profile: a blocking call of {@code connectTimeout} per step, no retry. It uses
 * MINA's own chain ({@code HostConfigEntry.setProxyJump}): pilot P3-5 showed that the jump hop and the target authenticate with their own credentials
 * ({@link HopIdentities}) and that the host key verifier is asked per hop ({@link HopHostKeyVerifier}). MINA opens a loopback listener of its own for the forwarding
 * of a chain (the {@code createLocalPortForwardingTracker} of {@code SshClient.doConnect}); that listener lives as long as the connection. The jump hosts are given to MINA
 * through {@link JumpEntries}, never as host names in a {@link java.net.URI}.
 */
@Component
public final class SessionConnector {

    private final ProxyJumpResolver resolver;
    private final MinaClientFactory clients;
    private final ServerKeyPolicy hostKeys;
    private final SshSettings settings;

    /**
     * @param hostKeys the host key policy of the installation ({@code ssh.hostkey}): it makes the verifier of every hop's profile, pins and mode included
     */
    public SessionConnector(ProxyJumpResolver resolver, MinaClientFactory clients, ServerKeyPolicy hostKeys, SshSettings settings) {
        this.resolver = resolver;
        this.clients = clients;
        this.hostKeys = hostKeys;
        this.settings = settings;
    }

    /** Connects to the profile's target; blocks up to {@code connectTimeout} for the connection and again for the login. */
    ConnectOutcome connect(ProfileAlias alias) {
        JumpResolution resolution = resolver.resolve(alias);
        if (!(resolution instanceof JumpResolution.Resolved resolved)) {
            return new ConnectOutcome.Failed(((JumpResolution.Failed) resolution).failure());
        }
        List<Hop> hops = resolved.hops();
        HopRouting routing = new HopRouting(hops);
        ConnectAttempt attempt = new ConnectAttempt();
        HopIdentities identities = new HopIdentities(routing, attempt);
        SshClient client = clients.newClient(new HopHostKeyVerifier(routing, hostKeys, attempt), identities, identities);
        client.addSessionListener(new SessionListener() {
            @Override
            public void sessionEvent(Session session, SessionListener.Event event) {
                if (event == SessionListener.Event.Authenticated) {
                    attempt.authenticated(routing.find(session));
                }
            }
        });
        try {
            Hop target = resolved.target();
            HostConfigEntry entry = new HostConfigEntry("portal-target", target.profile().host(), target.profile().port(), target.profile().user());
            if (hops.size() > 1) {
                JumpEntries jumps = new JumpEntries(hops.subList(0, hops.size() - 1));
                client.setHostConfigEntryResolver(jumps.resolver());
                entry.setProxyJump(jumps.specification());
            }
            ClientSession session = client.connect(entry).verify(settings.connectTimeout()).getSession();
            session.auth().verify(settings.connectTimeout());
            return new ConnectOutcome.Connected(client, session, hops);
        } catch (IOException | RuntimeException e) {
            client.stop();
            return new ConnectOutcome.Failed(attempt.diagnose(hops));
        }
    }
}
