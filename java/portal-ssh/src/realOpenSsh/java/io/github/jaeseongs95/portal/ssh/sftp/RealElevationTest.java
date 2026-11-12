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
import java.io.IOException;
import org.apache.sshd.sftp.client.SftpClient;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * Elevation on a real server: pilot P3-4 (the SFTP server of the target started with {@code sudo -n} and spoken to with MINA's own client over an {@code exec} channel) and
 * the administrator probe of a Windows server (S3-RO-07, S3-RW-06, S3-EL-03). They run only through the Gradle task {@code realOpenSshTest}; nothing here was run on the
 * machine that wrote it. The server's system is data ({@link RealServer#isWindows()}), so the same test runs on both and no test is skipped. The elevated file work through
 * the whole adapter is {@code RealSftpTest#elevatedRoundTrip}.
 */
@Timeout(300)
class RealElevationTest {

    @Test
    @DisplayName("S3-RO-07 P3-4 on an account with passwordless sudo the SFTP server runs under sudo -n and MINA's client speaks to it over exec and lists the root directory; elsewhere the opening says why not")
    void sftpServerUnderSudo() throws IOException {
        try (RealServer server = RealServer.open()) {
            boolean sudoWorks = server.exec("sudo -n true").exitStatus() == 0;

            SudoSftpChannels.Opening opening = new SudoSftpChannels(new SftpChannels()).open(server.session());

            if (sudoWorks && !server.isWindows()) {
                assertThat(opening).as("the account may use sudo -n: the server program is found and starts").isInstanceOf(SudoSftpChannels.Opening.Opened.class);
                try (SftpClient client = ((SudoSftpChannels.Opening.Opened) opening).client()) {
                    assertThat(client.stat("/").isDirectory()).isTrue();
                }
            } else {
                assertThat(opening).as("no passwordless sudo, or no sudo at all: no elevated channel").isNotInstanceOf(SudoSftpChannels.Opening.Opened.class);
                if (opening instanceof SudoSftpChannels.Opening.Opened opened) {
                    opened.client().close();
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
