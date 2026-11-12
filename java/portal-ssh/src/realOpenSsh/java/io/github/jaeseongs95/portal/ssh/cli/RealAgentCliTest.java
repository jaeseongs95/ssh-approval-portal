package io.github.jaeseongs95.portal.ssh.cli;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusResult;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.target.TargetPlatform;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.agentcli.ClaudeCliProvider;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.ssh.platform.LinuxTargetPlatform;
import io.github.jaeseongs95.portal.ssh.platform.PosixCommandLineGrammar;
import io.github.jaeseongs95.portal.ssh.platform.PythonSourceReceiver;
import io.github.jaeseongs95.portal.ssh.platform.RemoteScripts;
import io.github.jaeseongs95.portal.ssh.platform.WindowsCommandLineGrammar;
import io.github.jaeseongs95.portal.ssh.platform.WindowsCommandWrapper;
import io.github.jaeseongs95.portal.ssh.platform.WindowsTargetPlatform;
import io.github.jaeseongs95.portal.ssh.sftp.AtomicReplacer;
import io.github.jaeseongs95.portal.ssh.sftp.ElevatedExecTransfer;
import io.github.jaeseongs95.portal.ssh.sftp.ElevationProbe;
import io.github.jaeseongs95.portal.ssh.sftp.MinaRemoteFileTransfer;
import io.github.jaeseongs95.portal.ssh.sftp.RealServer;
import io.github.jaeseongs95.portal.ssh.sftp.RemotePathChecker;
import io.github.jaeseongs95.portal.ssh.sftp.SftpChannels;
import io.github.jaeseongs95.portal.ssh.sftp.SftpDownloader;
import io.github.jaeseongs95.portal.ssh.sftp.SftpFailureClassifier;
import io.github.jaeseongs95.portal.ssh.sftp.SftpUploader;
import io.github.jaeseongs95.portal.ssh.sftp.SpaceProbe;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.Base64;
import java.util.zip.GZIPOutputStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * The agent CLI installation on a real server (S3-RO-06, pilot P3-6, the real-server counterpart of S3-AG-01): a package that is a real {@code .tgz} made here is
 * installed with the fixed commands of the server's platform and read back. It runs only through the Gradle task {@code realOpenSshTest}; nothing here was run on the
 * machine that wrote it. What it shows: {@code tar} (or {@code tar.exe}) unpacks the package, the version is read from {@code package.json}, {@code current} is switched
 * and read back, the status reads it over SFTP. What it cannot show: whether the real packages of the tools run on the target without {@code npm} or {@code node}
 * (the question of pilot P3-6); the package here only has a metadata file. The package is the fake one of the design, not a download from the registry.
 */
@Timeout(300)
class RealAgentCliTest {

    private static final String VERSION = "1.2.3";

    @Test
    @DisplayName("S3-RO-06 P3-6 a real tgz is unpacked, its version read, current switched and read back on a real server; the status then shows the version")
    void installAndStatus() throws IOException {
        byte[] tarball = tarballWithPackageJson();
        RemoteScripts scripts = new RemoteScripts();
        PythonSourceReceiver receiver = new PythonSourceReceiver(scripts, new Sha256Digester());
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setDaemon(true);
        scheduler.initialize();
        try (RealServer server = RealServer.open()) {
            TargetPlatform platform = server.isWindows()
                ? new WindowsTargetPlatform(new WindowsCommandLineGrammar(), new WindowsCommandWrapper(scripts), receiver)
                : new LinuxTargetPlatform(command -> {
                    throw new IllegalStateException("not used");
                }, new PosixCommandLineGrammar(), receiver);
            String integrity = "sha512-" + Base64.getEncoder().encodeToString(sha512(tarball));
            AgentRelease release = AgentRelease.verify(new ClaudeCliProvider(), "@anthropic-ai/claude-code", VERSION,
                "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-" + VERSION + ".tgz", integrity, new Sha256Digester());
            AgentCliPlan plan = platform.agentCliPlan(intentOf(release), release);
            SftpFailureClassifier classifier = new SftpFailureClassifier();
            RemotePathChecker checker = new RemotePathChecker((id, path) -> new PathPolicyDecision.NotApplicable(), classifier);
            AtomicReplacer replacer = new AtomicReplacer(checker, classifier, new SecureRandom(), Clock.systemUTC());
            SftpChannels channels = new SftpChannels();
            ElevationProbe probe = new ElevationProbe(server.executor(), id -> new TargetLookup.NotRegistered(id));
            MinaRemoteFileTransfer transfer = new MinaRemoteFileTransfer(server.sessions(), channels, checker, new SftpUploader(checker, replacer, classifier, channels, new SpaceProbe()),
                new SftpDownloader(checker, classifier), classifier, new ElevatedExecTransfer(probe, server.executor(), replacer, Clock.systemUTC()), probe, scheduler,
                Clock.systemUTC());
            AgentCliInstaller installer = new AgentCliInstaller(server.executor(), transfer, server.sessions(), channels, Clock.systemUTC());
            RemoteTarget target = new RemoteTarget(new TargetId("realserver"), TargetRevision.of("b".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);
            ExecutionControl control = new ExecutionControl(new CancelSource(), () -> { });
            PayloadSource source = () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(tarball)), tarball.length);

            AgentCliInstallResult installed = installer.install(new AgentCliInstallRequest(target, plan, source, TransferLimits.defaults()), control);
            AgentCliStatusResult status = installer.status(new AgentCliStatusRequest(target, AgentCliProviderId.CLAUDE, ExecutionLimits.defaults()), control);
            AgentCliInstallResult again = installer.install(new AgentCliInstallRequest(target, plan, source, TransferLimits.defaults()), control);

            try {
                assertThat(installed).as("the first installation").isInstanceOf(AgentCliInstallResult.Installed.class);
                assertThat(status).isInstanceOf(AgentCliStatusResult.Observed.class);
                assertThat(((AgentCliStatusResult.Observed) status).remote()).isEqualTo(new RemoteStatus.Known(RemoteState.COMPLETED, new CliVersion(VERSION), 0));
                assertThat(again).as("the same release is already current").isEqualTo(new AgentCliInstallResult.Reused(new CliVersion(VERSION)));
            } finally {
                removeInstallation(server);
            }
        } finally {
            scheduler.shutdown();
        }
    }

    private void removeInstallation(RealServer server) throws IOException {
        server.exec(server.isWindows() ? "cmd /c rmdir /s /q \"%USERPROFILE%\\.ssh-approval-portal\\agent-cli\\claude\"" : "rm -rf \"$HOME/.ssh-approval-portal/agent-cli/claude\"");
    }

    private io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent intentOf(AgentRelease release) {
        io.github.jaeseongs95.portal.domain.id.Digest any = new Sha256Digester().digestUtf8("any");
        return new io.github.jaeseongs95.portal.domain.agentcli.AgentCliIntent(new TargetId("realserver"), TargetRevision.of("b".repeat(64)), new ProfileAlias("writer"),
            release.provider(), io.github.jaeseongs95.portal.domain.agentcli.AgentCliAction.INSTALL, release.releaseDigest(), any, java.time.Instant.parse("2030-01-01T00:00:00Z"), any,
            new io.github.jaeseongs95.portal.domain.id.RequestKey("real-server-request-key-01"));
    }

    private static byte[] sha512(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-512").digest(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A {@code .tgz} with the one file {@code package/package.json}: a tar header (ustar), the content padded to 512 bytes, two empty blocks, gzipped. */
    private static byte[] tarballWithPackageJson() throws IOException {
        byte[] content = ("{\"name\":\"fixture\",\"version\":\"" + VERSION + "\"}\n").getBytes(StandardCharsets.UTF_8);
        byte[] header = new byte[512];
        put(header, 0, "package/package.json");
        put(header, 100, "0000644");
        put(header, 108, "0000000");
        put(header, 116, "0000000");
        put(header, 124, String.format("%011o", content.length));
        put(header, 136, String.format("%011o", 0));
        header[156] = '0';
        put(header, 257, "ustar");
        put(header, 263, "00");
        for (int index = 148; index < 156; index++) {
            header[index] = ' ';
        }
        int sum = 0;
        for (byte value : header) {
            sum += value & 0xff;
        }
        put(header, 148, String.format("%06o", sum));
        header[154] = 0;
        header[155] = ' ';
        ByteArrayOutputStream tar = new ByteArrayOutputStream();
        tar.write(header);
        tar.write(content);
        tar.write(new byte[(512 - content.length % 512) % 512]);
        tar.write(new byte[1024]);
        ByteArrayOutputStream gzip = new ByteArrayOutputStream();
        try (GZIPOutputStream out = new GZIPOutputStream(gzip)) {
            out.write(tar.toByteArray());
        }
        return gzip.toByteArray();
    }

    private static void put(byte[] header, int offset, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(bytes, 0, header, offset, bytes.length);
    }
}
