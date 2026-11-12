package io.github.jaeseongs95.portal.ssh.pilot;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ReceivedSignal;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.IOException;
import java.time.Duration;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.io.IoWriteFuture;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.apache.sshd.server.Signal;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Pilot P3-3 of docs/migration/stage3-design.md (0.3 item 1, 3.3, decision D3-05): MINA 2.20.1 has no public client method that sends a {@code signal} channel request, so the
 * request is written as a packet: {@code Session.createBuffer(SSH_MSG_CHANNEL_REQUEST)}, the recipient channel number, {@code "signal"}, want-reply false, the signal name
 * without the {@code SIG} prefix (RFC 4254 6.9), then {@code Session.writePacket}. These tests check that the MINA test server delivers such a request to the command through
 * {@code Environment.addSignalListener} (what {@code ServerChannelSession.handleSignal} does in the 2.20.1 source), and what the client sees when the command reacts.
 */
@Timeout(60)
class ChannelSignalPilotTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final Duration LIMIT = SshTestClient.LIMIT;

    private EmbeddedSshServer server;
    private SshTestClient client;

    @BeforeEach
    void start() throws IOException {
        server = EmbeddedSshServer.builder()
            .password(USER, PASSWORD)
            .script("hang", ScriptedCommand.hangs())
            .script("dies on INT", ScriptedCommand.endsOnSignal(Signal.INT, 130))
            .start();
        client = SshTestClient.startAcceptingAnyHostKey();
    }

    @AfterEach
    void stop() throws IOException {
        client.close();
        server.close();
    }

    /** The signal request as a raw channel request packet (RFC 4254 6.9). The want-reply flag is false, as the stage 3 design plans it. */
    private static void sendSignal(ChannelExec channel, String name) throws IOException {
        Session session = channel.getSession();
        Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_CHANNEL_REQUEST);
        buffer.putUInt(channel.getRecipient());
        buffer.putString("signal");
        buffer.putBoolean(false);
        buffer.putString(name);
        IoWriteFuture written = session.writePacket(buffer);
        assertThat(written.await(LIMIT)).as("the packet was handed to the transport in time").isTrue();
        assertThat(written.isWritten()).isTrue();
    }

    @Test
    @DisplayName("P3-3 a signal request written with createBuffer(SSH_MSG_CHANNEL_REQUEST) reaches the server command's Environment signal listener")
    void aRawSignalRequestReachesTheCommand() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD); ChannelExec channel = client.startExec(session, "hang")) {
            server.startedCommands().await(1, LIMIT); // the command registered its listener
            sendSignal(channel, "INT");
            List<ReceivedSignal> received = server.receivedSignals().await(1, LIMIT);
            assertThat(received).containsExactly(new ReceivedSignal("hang", Signal.INT));
        }
    }

    @Test
    @DisplayName("P3-3 INT, TERM and KILL in the order the stop procedure sends them arrive in that order; a command that ignores signals keeps running")
    void theStopSequenceArrivesInOrderAndAnIgnoringCommandKeepsRunning() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD); ChannelExec channel = client.startExec(session, "hang")) {
            server.startedCommands().await(1, LIMIT);
            sendSignal(channel, "INT");
            sendSignal(channel, "TERM");
            sendSignal(channel, "KILL");
            List<ReceivedSignal> received = server.receivedSignals().await(3, LIMIT);
            assertThat(received).extracting(ReceivedSignal::signal).containsExactly(Signal.INT, Signal.TERM, Signal.KILL);
            Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), Duration.ofMillis(500));
            assertThat(events).as("a signal request is no proof of an end: the command ignored all three").contains(ClientChannelEvent.TIMEOUT).doesNotContain(ClientChannelEvent.CLOSED);
            assertThat(channel.getExitStatus()).isNull();
            assertThat(server.destroyedCommands().snapshot()).isEmpty();
        }
    }

    @Test
    @DisplayName("P3-3 a command that ends on INT reports its exit status to the client after the signal request")
    void aCommandThatEndsOnTheSignalReportsItsExitStatus() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD); ChannelExec channel = client.startExec(session, "dies on INT")) {
            server.startedCommands().await(1, LIMIT);
            sendSignal(channel, "INT");
            Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
            assertThat(events).contains(ClientChannelEvent.CLOSED);
            assertThat(channel.getExitStatus()).isEqualTo(130);
            assertThat(server.receivedSignals().snapshot()).containsExactly(new ReceivedSignal("dies on INT", Signal.INT));
        }
    }

    @Test
    @DisplayName("P3-3 a signal name MINA does not know is not delivered to the command; the channel and the command are unaffected")
    void anUnknownSignalNameIsNotDelivered() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD); ChannelExec channel = client.startExec(session, "hang")) {
            server.startedCommands().await(1, LIMIT);
            sendSignal(channel, "NOSUCH");
            sendSignal(channel, "TERM"); // a known one behind it: when it has arrived, the unknown one has been handled too
            List<ReceivedSignal> received = server.receivedSignals().await(1, LIMIT);
            assertThat(received).extracting(ReceivedSignal::signal).containsExactly(Signal.TERM);
            assertThat(channel.isOpen()).isTrue();
        }
    }
}
