package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.ssh.platform.PythonSourceReceiver;
import io.github.jaeseongs95.portal.ssh.platform.RemoteScripts;
import io.github.jaeseongs95.portal.ssh.platform.WindowsCommandLineGrammar;
import io.github.jaeseongs95.portal.ssh.platform.WindowsCommandWrapper;
import io.github.jaeseongs95.portal.ssh.platform.WindowsTargetPlatform;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.time.Duration;
import java.util.EnumSet;
import org.apache.sshd.client.channel.ChannelExec;
import org.apache.sshd.client.channel.ClientChannelEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Elevation on a real server: pilot P3-4 (can an SFTP server run under {@code sudo -n} and be spoken to over an exec channel) and the administrator probe of a Windows server
 * (S3-RO-02, S3-RW-06, S3-EL-01, S3-EL-03). They run only through the Gradle task {@code realOpenSshTest}; nothing here was run on the machine that wrote it.
 *
 * <p>What the P3-4 test shows is the first half of the question: whether {@code sudo -n} starts the SFTP server and the server answers the SFTP handshake on an exec
 * channel. Whether MINA's {@code SftpClient} can be attached to such a channel is a separate question that its public API does not answer (it opens the {@code sftp}
 * subsystem itself); until it is shown, the elevated file work is the fixed-command fallback ({@link ElevatedExecTransfer}, ruling 11.2).
 */
@Timeout(300)
class RealElevationTest {

    private static final Duration LIMIT = Duration.ofSeconds(30);
    /** The SFTP packet SSH_FXP_INIT, version 3: length 5, type 1, version 3. */
    private static final byte[] SFTP_INIT = {0, 0, 0, 5, 1, 0, 0, 0, 3};

    @Test
    @DisplayName("S3-RO-02 P3-4 a POSIX account with passwordless sudo can start the SFTP server under sudo -n and gets the SSH_FXP_VERSION answer on an exec channel; an account without sudo cannot")
    void sftpServerUnderSudo() throws IOException {
        try (RealServer server = RealServer.open()) {
            RealServer.Result probe = server.exec("sudo -n true");
            if (server.isWindows()) {
                // A Windows server has no sudo: the probe of its platform is the administrator check, below.
                assertThat(probe.exitStatus()).as("sudo does not exist on this server").isNotZero();
                return;
            }
            // The path of the sftp-server binary is the server's: the first of the usual places that exists is used (docs/migration pilot P3-4 question 2).
            RealServer.Result binary = server.exec("for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do "
                + "if [ -x \"$p\" ]; then printf '%s' \"$p\"; break; fi; done");
            assertThat(binary.stdout()).as("the account's server has an sftp-server binary in a usual place").isNotBlank();

            try (ChannelExec channel = server.session().createExecChannel("sudo -n " + binary.stdout().strip())) {
                ByteArrayOutputStream answer = new ByteArrayOutputStream();
                channel.setOut(answer);
                channel.setErr(OutputStream.nullOutputStream());
                channel.setIn(new java.io.ByteArrayInputStream(SFTP_INIT));
                channel.open().verify(LIMIT);
                channel.waitFor(EnumSet.of(ClientChannelEvent.CLOSED), LIMIT.toMillis());
                byte[] bytes = answer.toByteArray();

                if (probe.exitStatus() == 0) {
                    // SSH_FXP_VERSION (type 2) with the version the server speaks.
                    assertThat(bytes.length).as("an SFTP server started under sudo answers the handshake").isGreaterThanOrEqualTo(9);
                    assertThat(bytes[4]).isEqualTo((byte) 2);
                } else {
                    assertThat(bytes).as("without passwordless sudo nothing is served").isEmpty();
                }
            }
        }
    }

    @Test
    @DisplayName("S3-RW-06 S3-EL-03 the administrator probe of a Windows server ends with 0 or 1 (never with a script error); a POSIX server ends its sudo probe with 0 or 1")
    void probeEndsWithAnExitCode() throws IOException {
        RemoteScripts scripts = new RemoteScripts();
        WindowsTargetPlatform windows = new WindowsTargetPlatform(new WindowsCommandLineGrammar(), new WindowsCommandWrapper(scripts),
            new PythonSourceReceiver(scripts, new Sha256Digester()));
        try (RealServer server = RealServer.open()) {
            FixedRemoteCommand probe = server.isWindows()
                ? ((ElevationPlan.WindowsAdministratorCheck) windows.elevationPlan()).probe()
                : new FixedRemoteCommand("sudo-probe", "sudo -n true");

            RealServer.Result result = server.exec(probe.commandLine());

            assertThat(result.exitStatus()).as("stderr: %s", result.stderr()).isIn(0, 1);
        }
    }
}
