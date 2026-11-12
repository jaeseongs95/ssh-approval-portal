package io.github.jaeseongs95.portal.ssh.realopenssh;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.OutputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.session.ClientSession;
import org.apache.sshd.common.SshConstants;
import org.apache.sshd.common.channel.exception.SshChannelOpenException;
import org.apache.sshd.common.util.buffer.Buffer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Case S3-RO-05 of docs/migration/stage3-design.md (7.2), the real-server half of the session cases of the pool (S3-SS-01, S3-SS-04): what a real OpenSSH server does when a
 * session asks for more channels than the server's {@code MaxSessions} allows, and whether it answers the liveness probe {@code keepalive@openssh.com} that the session pool
 * sends before it reuses an idle session. They run only through the Gradle task {@code realOpenSshTest}; nothing here was run on the machine that wrote it.
 */
@Timeout(300)
class OpenSshSessionPilotTest {

    private static final Duration LIMIT = OpenSshClient.LIMIT;
    /** More than the 10 sessions an OpenSSH server allows by default (sshd_config MaxSessions). */
    private static final int ATTEMPTS = 12;

    private final OpenSshTarget target = OpenSshTarget.fromSystemProperties();

    private static Buffer keepAlive(ClientSession session) {
        Buffer buffer = session.createBuffer(SshConstants.SSH_MSG_GLOBAL_REQUEST);
        buffer.putString("keepalive@openssh.com");
        buffer.putBoolean(true);
        return buffer;
    }

    private static boolean isRefusal(Throwable failure) {
        for (Throwable current = failure; current != null; current = current.getCause()) {
            if (current instanceof SshChannelOpenException) {
                return true;
            }
        }
        return false;
    }

    @Test
    @DisplayName("S3-RO-05 a real server refuses the channel that is over MaxSessions with an open failure, and the session stays usable")
    void channelsOverMaxSessionsAreRefused() throws Exception {
        String longRunning = switch (target.platform()) {
            case LINUX -> "sleep 120";
            case WINDOWS -> "ping -n 120 127.0.0.1";
        };
        try (OpenSshClient connection = OpenSshClient.open(target)) {
            ClientSession session = connection.session();
            List<ChannelExec> channels = new ArrayList<>();
            int refusals = 0;
            try {
                for (int i = 0; i < ATTEMPTS; i++) {
                    ChannelExec channel = session.createExecChannel(longRunning);
                    channel.setOut(OutputStream.nullOutputStream());
                    channel.setErr(OutputStream.nullOutputStream());
                    channels.add(channel);
                    try {
                        channel.open().verify(LIMIT);
                    } catch (IOException e) {
                        assertThat(isRefusal(e)).as("the refusal is a channel open failure, not a lost connection").isTrue();
                        refusals++;
                    }
                }
                assertThat(refusals).as("a server with the default MaxSessions refuses at least one of " + ATTEMPTS + " channels").isGreaterThan(0);
                assertThat(session.isOpen()).as("a refused channel does not kill the session").isTrue();
            } finally {
                for (ChannelExec channel : channels) {
                    channel.close(true);
                }
            }
        }
    }

    @Test
    @DisplayName("S3-RO-05 a real server answers the liveness probe (success or failure, both prove it alive); after the connection is cut the probe fails with an I/O error")
    void theLivenessProbe() throws Exception {
        try (OpenSshClient connection = OpenSshClient.open(target)) {
            ClientSession session = connection.session();
            session.request("keepalive@openssh.com", keepAlive(session), LIMIT); // returns the reply buffer or null; either is an answer, neither throws
            session.close(true);
            assertThatThrownBy(() -> session.request("keepalive@openssh.com", keepAlive(session), LIMIT)).isInstanceOf(IOException.class);
        }
    }
}
