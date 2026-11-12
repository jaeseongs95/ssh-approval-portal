package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.ssh.hostkey.ServerKeyPolicy;
import java.net.SocketAddress;
import java.security.PublicKey;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.apache.sshd.client.keyverifier.ServerKeyVerifier;
import org.apache.sshd.client.session.ClientSession;

/**
 * The host key check of one connection, hop by hop. MINA has one verifier per client and asks it about every session of a chain (the jump sessions and the target's), so this
 * verifier finds the hop of the session ({@link HopRouting}) and hands the question to the verifier the {@link ServerKeyPolicy} makes for that hop's profile: the pin of the
 * profile when it has one, the installation's mode (trust on first use, strict, none) otherwise. The decision, the known_hosts record and the report of a refusal are the
 * policy's; this class only notes a refusal in the {@link ConnectAttempt}, so the failure can be told from an unreachable host.
 */
final class HopHostKeyVerifier implements ServerKeyVerifier {

    private final HopRouting routing;
    private final ServerKeyPolicy policy;
    private final ConnectAttempt attempt;
    private final Map<ProfileAlias, ServerKeyVerifier> verifiers = new ConcurrentHashMap<>();

    HopHostKeyVerifier(HopRouting routing, ServerKeyPolicy policy, ConnectAttempt attempt) {
        this.routing = routing;
        this.policy = policy;
        this.attempt = attempt;
    }

    @Override
    public boolean verifyServerKey(ClientSession clientSession, SocketAddress remoteAddress, PublicKey serverKey) {
        Hop hop = routing.find(clientSession);
        ServerKeyVerifier verifier = verifiers.computeIfAbsent(hop.alias(), alias -> policy.verifierFor(hop.profile()));
        boolean accepted = verifier.verifyServerKey(clientSession, remoteAddress, serverKey);
        if (!accepted) {
            attempt.hostKeyRefused(hop);
        }
        return accepted;
    }
}
