package io.github.jaeseongs95.portal.ssh.pilot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.time.Duration;
import java.util.EnumSet;
import java.util.Set;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.client.session.ClientSession.ClientSessionEvent;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Pilot P3-2 of docs/migration/stage3-design.md (3.5): an active "is this session alive" check before a pooled session is reused, with the global request
 * {@code keepalive@openssh.com} and a reply wanted. The MINA 2.20.1 public API is {@code Session.request(String request, Buffer buffer, Duration timeout)}: the buffer is a
 * {@code SSH_MSG_GLOBAL_REQUEST} made with {@code Session.createBuffer}, the request name and the want-reply flag written by the caller. Per the source of
 * {@code AbstractSession.request}: it returns the reply buffer on SUCCESS, returns null on FAILURE (or SSH_MSG_UNIMPLEMENTED), throws {@code SocketTimeoutException} when
 * nothing answers within the limit, and throws an {@code IOException} when the session is closed or closing.
 */
@Timeout(60)
class SessionProbePilotTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final Duration PROBE_LIMIT = Duration.ofSeconds(5);
    private static final String KEEPALIVE = "keepalive@openssh.com";

    private EmbeddedSshServer server;
    private SshTestClient client;

    @BeforeEach
    void start() throws IOException {
        server = EmbeddedSshServer.builder().password(USER, PASSWORD).start();
        client = SshTestClient.startAcceptingAnyHostKey();
    }

    @AfterEach
    void stop() throws IOException {
        client.close();
        server.close();
    }

    /** The probe: a global request with the reply wanted (RFC 4254 4). The name is written into the buffer and passed again as the first argument of {@code request}. */
    private static Buffer globalRequest(Session session, String name) {
        Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_GLOBAL_REQUEST);
        buffer.putString(name);
        buffer.putBoolean(true);
        return buffer;
    }

    private static Buffer probe(Session session, Duration limit) throws IOException {
        return session.request(KEEPALIVE, globalRequest(session, KEEPALIVE), limit);
    }

    @Test
    @DisplayName("P3-2 a live session answers keepalive@openssh.com with a success reply buffer")
    void aLiveSessionAnswers() throws IOException {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            Buffer reply = probe(session, PROBE_LIMIT);
            assertThat(reply != null).as("SSH_MSG_REQUEST_SUCCESS: a reply buffer, not null").isTrue();
            assertThat(session.isOpen()).isTrue();
        }
    }

    @Test
    @DisplayName("P3-2 a global request the server does not know is answered with FAILURE: request() returns null, which still proves the peer is alive")
    void aFailureReplyIsNullAndMeansAlive() throws IOException {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            String unknown = "probe-unknown@example.invalid";
            Buffer failure = session.request(unknown, globalRequest(session, unknown), PROBE_LIMIT);
            assertThat(failure == null).as("SSH_MSG_REQUEST_FAILURE: request() returns null").isTrue();
            Buffer next = probe(session, PROBE_LIMIT);
            assertThat(next != null).as("the session is still usable after a FAILURE reply").isTrue();
        }
    }

    @Test
    @DisplayName("P3-2 a server that does not answer: the probe throws SocketTimeoutException after its limit, while the session stays open")
    void aSilentServerMakesTheProbeTimeOut() throws IOException {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            server.swallowKeepAlives(true);
            assertThatThrownBy(() -> probe(session, Duration.ofMillis(500))).isInstanceOf(SocketTimeoutException.class);
            assertThat(session.isOpen()).as("a timed-out probe does not close the session: the caller must").isTrue();
        }
    }

    @Test
    @DisplayName("P3-2 prediction from the source: after a timed-out probe the pending request stays queued, so the next reply is matched to the old request and the next probe times out as well")
    void aTimedOutProbeLeavesTheSessionUnfitForFurtherProbes() throws IOException {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            server.swallowKeepAlives(true);
            assertThatThrownBy(() -> probe(session, Duration.ofMillis(500))).isInstanceOf(SocketTimeoutException.class);
            server.swallowKeepAlives(false);
            assertThatThrownBy(() -> probe(session, Duration.ofMillis(500))).as("global replies are matched in order: the reply belongs to the abandoned first probe")
                .isInstanceOf(SocketTimeoutException.class);
        }
    }

    @Test
    @DisplayName("P3-2 the server disconnected the idle session: once the client has seen the close, the probe fails at once with an IOException")
    void aDisconnectedSessionFailsTheProbe() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(server.disconnectIdleSessions()).isEqualTo(1);
            Set<ClientSessionEvent> events = session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), SshTestClient.LIMIT);
            assertThat(events).contains(ClientSessionEvent.CLOSED);
            assertThat(session.isOpen()).isFalse();
            assertThatThrownBy(() -> probe(session, PROBE_LIMIT)).isInstanceOf(IOException.class);
        }
    }

    @Test
    @DisplayName("P3-2 the server dropped the connection: the probe fails with an IOException before or after the client has noticed, never with a success")
    void aDroppedConnectionFailsTheProbe() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(server.dropConnections()).isEqualTo(1);
            // Not waiting for the client to notice: the probe itself must not report a live session.
            assertThatThrownBy(() -> probe(session, Duration.ofSeconds(3))).isInstanceOf(IOException.class);
            Set<ClientSessionEvent> events = session.waitFor(EnumSet.of(ClientSessionEvent.CLOSED), SshTestClient.LIMIT);
            assertThat(events).contains(ClientSessionEvent.CLOSED);
        }
    }
}
