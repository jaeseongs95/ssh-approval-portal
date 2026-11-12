package io.github.jaeseongs95.portal.ssh.session;

import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * What happened to the servers of one connection while it was made: which were asked for a credential, which logged in, whether a host key was refused. MINA reports a
 * chain as one connection and one exception, so this is what lets {@link SessionConnector} say which hop failed and why (design 3.6: "ProxyJump via ... failed").
 * Touched by MINA's threads; every field is thread safe.
 */
final class ConnectAttempt {

    private final Set<ProfileAlias> credentialAsked = ConcurrentHashMap.newKeySet();
    private final Set<ProfileAlias> authenticated = ConcurrentHashMap.newKeySet();
    private final AtomicReference<ProfileAlias> hostKeyRefusedAt = new AtomicReference<>();

    void credentialAsked(Hop hop) {
        credentialAsked.add(hop.alias());
    }

    void authenticated(Hop hop) {
        authenticated.add(hop.alias());
    }

    void hostKeyRefused(Hop hop) {
        hostKeyRefusedAt.compareAndSet(null, hop.alias());
    }

    /** The diagnosis of a failed connection to the hops, in the order they are connected. */
    ConnectFailure diagnose(List<Hop> hops) {
        ProfileAlias refused = hostKeyRefusedAt.get();
        if (refused != null) {
            return new ConnectFailure(ConnectFailureCause.HOST_KEY_REFUSED, refused);
        }
        for (Hop hop : hops) {
            if (!authenticated.contains(hop.alias())) {
                return new ConnectFailure(credentialAsked.contains(hop.alias()) ? ConnectFailureCause.AUTHENTICATION_FAILED : ConnectFailureCause.UNREACHABLE, hop.alias());
            }
        }
        // Every hop logged in and the connection still failed: the last step (the session of the target) did not finish.
        return new ConnectFailure(ConnectFailureCause.UNREACHABLE, hops.get(hops.size() - 1).alias());
    }
}
