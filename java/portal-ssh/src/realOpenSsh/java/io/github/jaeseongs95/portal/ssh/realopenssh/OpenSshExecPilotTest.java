package io.github.jaeseongs95.portal.ssh.realopenssh;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
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
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.io.IoWriteFuture;
import org.apache.sshd.common.session.ConnectionService;
import org.apache.sshd.common.session.Session;
import org.apache.sshd.common.util.buffer.Buffer;
import org.apache.sshd.core.CoreModuleProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Cases S3-RO-01 .. S3-RO-03 of docs/migration/stage3-design.md (7.2), the real-server counterparts of pilots P3-1 and P3-3 that the MINA test server cannot answer:
 * does a real OpenSSH server (Linux sshd, Win32-OpenSSH) reply to an exec request that asked for a reply, and what does it do with a {@code signal} channel request?
 * They run only through the Gradle task {@code realOpenSshTest}; the outcome on a real server is known only after that run (nothing here was run on the machine that wrote it).
 */
@Timeout(180)
class OpenSshExecPilotTest {

    private static final Duration LIMIT = OpenSshClient.LIMIT;

    private final OpenSshTarget target = OpenSshTarget.fromSystemProperties();

    /** A {@link ChannelExec} that records the reply to its exec request (the hooks MINA calls for SSH_MSG_CHANNEL_SUCCESS and _FAILURE). */
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

    private static ReplyAwareExec newExec(ClientSession session, String command, OutputStream out) throws IOException {
        ReplyAwareExec channel = new ReplyAwareExec(command);
        session.getService(ConnectionService.class).registerChannel(channel);
        channel.setOut(out);
        channel.setErr(OutputStream.nullOutputStream());
        return channel;
    }

    private static void sendSignal(ChannelExec channel, String name) throws IOException {
        Session session = channel.getSession();
        Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_CHANNEL_REQUEST);
        buffer.putUInt(channel.getRecipient());
        buffer.putString("signal");
        buffer.putBoolean(false);
        buffer.putString(name);
        IoWriteFuture written = session.writePacket(buffer);
        assertThat(written.await(LIMIT)).isTrue();
    }

    @Test
    @DisplayName("S3-RO-01 P3-1 a real server answers an exec request that asked for a reply with SUCCESS, and the output and exit status follow")
    void aRealServerAnswersTheExecRequestWithSuccess() throws Exception {
        try (OpenSshClient connection = OpenSshClient.open(target)) {
            ClientSession session = connection.session();
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (ReplyAwareExec channel = newExec(session, "echo portal-ok", out)) {
                channel.open().verify(LIMIT);
                assertThat(channel.accepted.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
                assertThat(events).contains(ClientChannelEvent.CLOSED);
                assertThat(channel.getExitStatus()).isZero();
                assertThat(channel.refused.isDone()).isFalse();
            }
            assertThat(out.toString(StandardCharsets.UTF_8).strip()).isEqualTo("portal-ok");
        }
    }

    @Test
    @DisplayName("S3-RO-02 P3-1 a real server accepts the exec request of a command that does not exist: SUCCESS first, then a non-zero exit status (not a refusal)")
    void aMissingCommandIsAcceptedAndFailsAfterwards() throws Exception {
        try (OpenSshClient connection = OpenSshClient.open(target)) {
            ClientSession session = connection.session();
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            try (ReplyAwareExec channel = newExec(session, "portal-no-such-command-4711", OutputStream.nullOutputStream())) {
                channel.open().verify(LIMIT);
                assertThat(channel.accepted.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
                assertThat(events).contains(ClientChannelEvent.CLOSED);
                assertThat(channel.getExitStatus()).isNotNull().isNotZero();
                assertThat(channel.refused.isDone()).isFalse();
            }
        }
    }

    @Test
    @DisplayName("S3-RO-03 P3-3 a signal request (INT) to a running command: Linux ends it with exit-signal INT; on Windows the channel can be closed whatever the server did")
    void aSignalRequestToARunningCommand() throws Exception {
        String longRunning = switch (target.platform()) {
            case LINUX -> "sleep 60";
            case WINDOWS -> "ping -n 60 127.0.0.1";
        };
        try (OpenSshClient connection = OpenSshClient.open(target)) {
            ClientSession session = connection.session();
            CoreModuleProperties.REQUEST_EXEC_REPLY.set(session, Boolean.TRUE);
            try (ReplyAwareExec channel = newExec(session, longRunning, OutputStream.nullOutputStream())) {
                channel.open().verify(LIMIT);
                assertThat(channel.accepted.get(LIMIT.toSeconds(), TimeUnit.SECONDS)).isTrue();
                sendSignal(channel, "INT");
                switch (target.platform()) {
                    case LINUX -> {
                        Set<ClientChannelEvent> events = channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT);
                        assertThat(events).contains(ClientChannelEvent.CLOSED);
                        assertThat(channel.getExitSignal()).isEqualTo("INT");
                    }
                    case WINDOWS -> {
                        // Whether Win32-OpenSSH acts on the signal is what this case finds out on its first run; what holds either way is that the stop procedure can end the channel.
                        channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), Duration.ofSeconds(5));
                        channel.close(false).await(LIMIT);
                        assertThat(channel.isOpen()).isFalse();
                    }
                }
            }
        }
    }
}
