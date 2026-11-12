package io.github.jaeseongs95.portal.ssh.session;

import java.net.InetSocketAddress;
import java.util.List;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.session.SessionContext;
import org.apache.sshd.common.util.net.SshdSocketAddress;

/**
 * Tells which server of a connection a MINA session is for. MINA's one client asks its host key verifier and its identity providers about every session of a chain
 * (the jump sessions and the target's), and the answer differs by server: the credential and the pinned host key are the profile's.
 *
 * <p>A session is a jump session when the address MINA connected it to ({@code ClientSession.getConnectAddress}, set before the key exchange) is the host and port of a
 * jump hop and its user is that hop's user. Every other session is the target's: its connect address is a local forwarding port of the jump session, and MINA reports the
 * target's own address only later (the {@code TARGET_SERVER} attribute), so no test of the target's address is relied on.
 */
final class HopRouting {

    private final List<Hop> hops;

    HopRouting(List<Hop> hops) {
        this.hops = List.copyOf(hops);
    }

    List<Hop> hops() {
        return hops;
    }

    Hop target() {
        return hops.get(hops.size() - 1);
    }

    /** The hop the session is for. */
    Hop find(SessionContext session) {
        if (session instanceof ClientSession clientSession && clientSession.getConnectAddress() != null) {
            InetSocketAddress address = SshdSocketAddress.toInetSocketAddress(clientSession.getConnectAddress());
            for (Hop hop : hops.subList(0, hops.size() - 1)) {
                String host = hop.profile().host();
                String bare = host.length() > 2 && host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
                if (hop.profile().port() == address.getPort() && bare.equalsIgnoreCase(address.getHostString())
                    && hop.profile().user().equals(clientSession.getUsername())) {
                    return hop;
                }
            }
        }
        return target();
    }
}
