package io.github.jaeseongs95.portal.ssh.session;

import java.util.List;
import java.util.Objects;
import org.apache.sshd.client.SshClient;
import org.apache.sshd.client.session.ClientSession;

/** The answer of {@link SessionConnector}: an authenticated session with the client that owns it, or the diagnosis of why there is none. */
sealed interface ConnectOutcome permits ConnectOutcome.Connected, ConnectOutcome.Failed {

    /**
     * The session is authenticated.
     *
     * @param client the client of this connection; stopping it closes the session
     * @param session the session of the target
     * @param hops the servers of the connection, the target last
     */
    record Connected(SshClient client, ClientSession session, List<Hop> hops) implements ConnectOutcome {
        public Connected {
            Objects.requireNonNull(client, "client");
            Objects.requireNonNull(session, "session");
            hops = List.copyOf(hops);
        }
    }

    /** No session was made. */
    record Failed(ConnectFailure failure) implements ConnectOutcome {
        public Failed {
            Objects.requireNonNull(failure, "failure");
        }
    }
}
