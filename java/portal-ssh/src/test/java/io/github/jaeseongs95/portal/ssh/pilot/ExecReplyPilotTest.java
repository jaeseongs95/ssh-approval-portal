package io.github.jaeseongs95.portal.ssh.pilot;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.ScriptedCommand;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.session.ConnectionService;
import org.apache.sshd.core.CoreModuleProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Pilot P3-1 of docs/migration/stage3-design.md (3.2, decision D3-06): what the MINA 2.20.1 client reports when the exec request asks for a reply
 * ({@code CoreModuleProperties.REQUEST_EXEC_REPLY}, default false) and the server refuses or accepts it. Against the MINA test server only; OpenSSH and Win32-OpenSSH
 * are the business of the S3-RO tests.
 *
 * <p>The source of MINA 2.20.1 ({@code ChannelExec.handleFailure}) says: on a FAILURE reply the client logs a warning and closes the channel with {@code close(true)}; it
 * throws nothing and sets no exit status. The open future has completed by then (the channel is confirmed before the exec reply). These tests pin that down, and show how a
 * subclass of {@code ChannelExec} (registered with the public {@code ConnectionService.registerChannel}) can tell "refused" from "closed without an exit status".
 */
@Timeout(60)
class ExecReplyPilotTest {

    private static final String USER = "tester";
    private static final String PASSWORD = "secret";
    private static final Duration LIMIT = SshTestClient.LIMIT;

    private EmbeddedSshServer server;
    private SshTestClient client;

    /** A {@link ChannelExec} that records the reply to its exec request: {@code handleSuccess} and {@code handleFailure} are the hooks MINA calls for SSH_MSG_CHANNEL_SUCCESS and _FAILURE. */
    private static final class ReplyAwareExec extends ChannelExec {
        private final CompletableFuture<Boolean> accepted = new CompletableFuture<>();
        private final CompletableFuture<Boolean> refused = new CompletableFuture<>();

        ReplyAwareExec(String command) {
            super(command, StandardCharsets.UTF_8, null, Map.of());
        }

        @Override
        public void handleSuccess() throws IOException {
            accepted.complete(Boolean.TRUE);
            super.handleSuccess();
        }

        @Override
        public void handleFailure() throws IOException {
            refused.complete(Boolean.TRUE);
            super.handleFailure();
        }
    }

    @BeforeEach
    void start() throws IOException {
        server = EmbeddedSshServer.builder()
            .password(USER, PASSWORD)
            .script("echo hello", ScriptedCommand.exits(0, "hello\n", ""))
            .script("refused", ScriptedCommand.refused())
            .script("hang", ScriptedCommand.hangs())
            .start();
        client = SshTestClient.startAcceptingAnyHostKey();
    }

    @AfterEach
    void stop() throws IOException {
        client.close();
        server.close();
    }

    private ReplyAwareExec newExec(ClientSession session, String command) throws IOException {
        ReplyAwareExec channel = new ReplyAwareExec(command);
        session.getService(ConnectionService.class).registerChannel(channel);
        return channel;
    }

    @Test
    @DisplayName("P3-1 REQUEST_EXEC_REPLY is false by default")
    void theReplyIsNotRequestedByDefault() throws IOException {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            assertThat(CoreModuleProperties.REQUEST_EXEC_REPLY.getRequired(session)).isFalse();
        }
    }

    @Test
    @DisplayName("P3-1 reply on, accepted exec: handleSuccess is called and the exit status arrives")
    void anAcceptedExecIsAnsweredWithSuccess() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (ReplyAwareExec channel = newExec(session, "echo hello")) {
                channel.setOut(out);
                channel.setErr(new ByteArrayOutputStream());
                channel.open().verify(LIMIT);
                assertThat(channel.accepted.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
                assertThat(events).contains(ClientChannelEvent.CLOSED);
                assertThat(channel.getExitStatus()).isZero();
                assertThat(channel.refused.isDone()).as("no FAILURE reply for an accepted exec").isFalse();
            }
            assertThat(out.toString(StandardCharsets.UTF_8)).isEqualTo("hello\n");
            assertThat(server.execRequestCount()).isEqualTo(1);
        }
    }

    @Test
    @DisplayName("P3-1 reply on, refused exec: the channel opens, handleFailure is called, and the channel closes with no exit status and no exception")
    void aRefusedExecIsAnsweredWithFailureAndClosesTheChannel() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            try (ReplyAwareExec channel = newExec(session, "refused")) {
                channel.open().verify(LIMIT); // the open itself succeeds: the exec reply comes after the channel confirmation
                assertThat(channel.refused.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
                assertThat(events).contains(ClientChannelEvent.CLOSED).doesNotContain(ClientChannelEvent.EXIT_STATUS, ClientChannelEvent.EXIT_SIGNAL);
                assertThat(channel.getExitStatus()).isNull();
                assertThat(channel.getExitSignal()).isNull();
                assertThat(channel.accepted.isDone()).isFalse();
            }
            assertThat(server.execRequests().snapshot()).containsExactly("refused");
            assertThat(server.startedCommands().snapshot()).as("the server never started a refused command").isEmpty();
        }
    }

    @Test
    @DisplayName("P3-1 reply off (the default), refused exec: the client gets no reply, no close and no exit status")
    void aRefusedExecIsSilentWhenNoReplyWasAsked() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            try (ReplyAwareExec channel = newExec(session, "refused")) {
                channel.open().verify(LIMIT);
                server.execRequests().await(1, LIMIT); // the request has reached the server: a reply, if there were one, is on its way
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), Duration.ofSeconds(1));
                assertThat(events).contains(ClientChannelEvent.TIMEOUT).doesNotContain(ClientChannelEvent.CLOSED);
                assertThat(channel.refused.isDone()).isFalse();
                assertThat(channel.accepted.isDone()).isFalse();
                assertThat(channel.getExitStatus()).isNull();
                assertThat(channel.isOpen()).as("the channel stays open although nothing runs: nothing tells the client the exec was refused").isTrue();
            }
        }
    }

    @Test
    @DisplayName("P3-1 reply on, accepted exec that keeps running: the success reply comes while the command is still running")
    void theSuccessReplyIsTheProofOfDispatchWhileTheCommandRuns() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            try (ReplyAwareExec channel = newExec(session, "hang")) {
                channel.open().verify(LIMIT);
                assertThat(channel.accepted.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), Duration.ofMillis(500));
                assertThat(events).contains(ClientChannelEvent.TIMEOUT).doesNotContain(ClientChannelEvent.CLOSED);
                server.startedCommands().await(1, LIMIT);
                channel.close(false).await(LIMIT);
            }
            server.destroyedCommands().await(1, LIMIT);
        }
    }

    @Test
    @DisplayName("P3-1 the reply flag can be set on the channel alone; the session keeps its default")
    void theReplyFlagCanBeSetPerChannel() throws Exception {
        try (ClientSession session = client.open(server, USER, PASSWORD)) {
            try (ReplyAwareExec channel = newExec(session, "refused")) {
                CoreModuleProperties.REQUEST_EXEC_REPLY.set(channel, Boolean.TRUE);
                channel.open().verify(LIMIT);
                assertThat(channel.refused.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
            }
            assertThat(CoreModuleProperties.REQUEST_EXEC_REPLY.getRequired(session)).isFalse();
        }
    }
}
