package io.github.jaeseongs95.portal.ssh.cli;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.cli.CliVersion;
import io.github.jaeseongs95.portal.app.cli.RemoteState;
import io.github.jaeseongs95.portal.app.cli.RemoteStatus;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliInstallResult;
import io.github.jaeseongs95.portal.app.remote.AgentCliPlan;
import io.github.jaeseongs95.portal.app.remote.AgentCliRefusal;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusRequest;
import io.github.jaeseongs95.portal.app.remote.AgentCliStatusResult;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.CancelToken;
import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.ExecutionReport;
import io.github.jaeseongs95.portal.app.remote.ExecutionTimeline;
import io.github.jaeseongs95.portal.app.remote.LoginState;
import io.github.jaeseongs95.portal.app.remote.OutputSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.RemoteExecution;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteFileTransfer;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.agentcli.AgentCliProviderId;
import io.github.jaeseongs95.portal.domain.agentcli.AgentRelease;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.ssh.platform.AgentCliLayout;
import io.github.jaeseongs95.portal.ssh.platform.LinuxTargetPlatform;
import io.github.jaeseongs95.portal.ssh.platform.PlatformFixtures;
import io.github.jaeseongs95.portal.ssh.platform.PosixCommandLineGrammar;
import io.github.jaeseongs95.portal.ssh.platform.PythonSourceReceiver;
import io.github.jaeseongs95.portal.ssh.platform.RemoteScripts;
import io.github.jaeseongs95.portal.ssh.sftp.SessionAcquisition;
import io.github.jaeseongs95.portal.ssh.sftp.SessionLease;
import io.github.jaeseongs95.portal.ssh.sftp.SessionSource;
import io.github.jaeseongs95.portal.ssh.sftp.SftpChannels;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import io.github.jaeseongs95.portal.ssh.testkit.SftpFault;
import io.github.jaeseongs95.portal.ssh.testkit.SshTestClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.client.session.ClientSession;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

/**
 * The agent CLI installer (S3-AG-01 to S3-AG-10, defect D-0035) on the embedded SFTP server: the directories, the reading of {@code current} and the switch are the
 * installer's own SFTP work, run for real; the unpacking, which is the one command of the target, is a test class that does what {@code tar} would do to the server's
 * directory; the upload of the package, which has its own tests, is a test class that writes the file. Where the file system of the machine makes no symbolic link, the
 * installer's own fallback (a pointer file) is what these tests exercise; the Linux build exercises the link.
 */
@Timeout(120)
class AgentCliInstallerTest {

    private static final byte[] PACKAGE = "the bytes of the package".getBytes(StandardCharsets.UTF_8);
    private static final RemoteTarget TARGET = new RemoteTarget(new TargetId("files"), TargetRevision.of("a".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);
    private static final String USER = "tester";
    private static final String PASSWORD = "secret-for-the-test";
    private static final String PACKAGE_JSON = "{\"name\":\"fixture\",\"version\":\"1.2.3\"}\n";

    @TempDir
    Path root;

    private final PlatformFixtures fixtures = new PlatformFixtures();
    private final RemoteScripts scripts = new RemoteScripts();
    private final LinuxTargetPlatform platform = new LinuxTargetPlatform(command -> {
        throw new IllegalStateException("not used");
    }, new PosixCommandLineGrammar(), new PythonSourceReceiver(scripts, new Sha256Digester()));
    private final List<AutoCloseable> toClose = new ArrayList<>();

    @AfterEach
    void closeAll() throws Exception {
        for (AutoCloseable closeable : toClose) {
            closeable.close();
        }
    }

    private static String integrityOf(byte[] bytes) {
        try {
            return "sha512-" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-512").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A package: its bytes and the plan to install it. A release with other bytes has another digest and so another directory. */
    private record Release(byte[] bytes, AgentRelease release, AgentCliPlan plan, String directory) {
    }

    private Release release(String contents) {
        byte[] bytes = contents.getBytes(StandardCharsets.UTF_8);
        AgentRelease release = fixtures.release(AgentCliProviderId.CLAUDE, integrityOf(bytes));
        AgentCliPlan plan = platform.agentCliPlan(fixtures.intent(release), release);
        return new Release(bytes, release, plan, new AgentCliLayout(AgentCliProviderId.CLAUDE, release).versionDirectory());
    }

    private Path toolDirectory() {
        return root.resolve(".ssh-approval-portal/agent-cli/claude");
    }

    /** The release directory that is current, read the way the installer writes it: the link, or the pointer file; empty when there is none. */
    private String current() throws IOException {
        Path link = toolDirectory().resolve("current");
        if (Files.isSymbolicLink(link)) {
            return link.toRealPath().getFileName().toString();
        }
        Path pointer = toolDirectory().resolve("current.txt");
        return Files.exists(pointer) ? Files.readString(pointer, StandardCharsets.UTF_8).strip() : "";
    }

    // ---- the doubles of this file ----

    /** What the unpack command does on the test target. */
    private sealed interface Unpacking permits Unpacking.Works, Unpacking.Exits, Unpacking.Lost {
        record Works(String metadata) implements Unpacking {
        }

        record Exits(int code) implements Unpacking {
        }

        record Lost() implements Unpacking {
        }
    }

    /** The target's shell for the one command: it records the command line and unpacks "package.tgz" by writing the metadata file the package would hold. */
    private static final class TarExecutor implements RemoteExecutor {
        private final Path base;
        private final List<String> commandLines = new ArrayList<>();
        private Unpacking behaviour = new Unpacking.Works(PACKAGE_JSON);

        TarExecutor(Path base) {
            this.base = base;
        }

        @Override
        public ExecutionReport run(RemoteExecution request, OutputSink sink, ExecutionControl control) {
            commandLines.add(request.command().commandLine());
            return switch (behaviour) {
                case Unpacking.Lost lost -> new ExecutionReport(ExecutionOutcome.transportLost(new ExecutionFailure.Classified(ExecutionStage.SSH_EXECUTION,
                    ExecutionErrorCode.SSH_EXECUTION_FAILED, RemoteOutcome.UNKNOWN), List.of()), ExecutionTimeline.empty());
                case Unpacking.Exits exits -> new ExecutionReport(ExecutionOutcome.exited(exits.code(), List.of()), ExecutionTimeline.empty());
                case Unpacking.Works works -> {
                    String command = request.command().commandLine();
                    String partial = command.substring(command.indexOf("$HOME/") + "$HOME/".length(), command.indexOf("\" && tar"));
                    Path directory = base.resolve(partial);
                    try {
                        assertThat(directory.resolve("package.tgz")).as("the package was uploaded where the command unpacks it").exists();
                        Files.createDirectories(directory.resolve("package"));
                        Files.writeString(directory.resolve("package/package.json"), works.metadata(), StandardCharsets.UTF_8);
                    } catch (IOException e) {
                        throw new IllegalStateException(e);
                    }
                    yield new ExecutionReport(ExecutionOutcome.exited(0, List.of()), ExecutionTimeline.empty());
                }
            };
        }
    }

    /** A file transfer that writes the package where the request says (the real one has its own tests) and answers what the test says. */
    private static final class WritingTransfer implements RemoteFileTransfer {
        private final Path base;
        private final List<UploadRequest> requests = new ArrayList<>();
        private UploadResult answer;

        WritingTransfer(Path base) {
            this.base = base;
        }

        @Override
        public UploadResult upload(UploadRequest request, PayloadSource source, ExecutionControl control) {
            requests.add(request);
            try (PayloadRead read = source.open()) {
                byte[] bytes = Channels.newInputStream(read.channel()).readAllBytes();
                if (answer == null) {
                    Path file = base.resolve(request.path().value().substring(1));
                    Files.createDirectories(file.getParent());
                    Files.write(file, bytes);
                }
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
            return answer != null ? answer : new UploadResult.Published(request.sha256(), Instant.parse("2026-11-12T00:00:00Z"), ReplaceMethod.POSIX_RENAME);
        }

        @Override
        public DownloadResult download(DownloadRequest request, PayloadSink sink, ExecutionControl control) {
            throw new IllegalStateException("the installer does not download");
        }

        @Override
        public PermissionResult applyPermissions(PermissionRequest request, ExecutionControl control) {
            throw new IllegalStateException("the installer sets no permissions");
        }

        @Override
        public ElevationResult checkElevation(ElevationRequest request, ExecutionControl control) {
            throw new IllegalStateException("the installer asks for no elevation");
        }
    }

    /** Leases a new session of the embedded server for every call; counts leases and discards. */
    private final class Sessions implements SessionSource {
        private final SshTestClient client = SshTestClient.startAcceptingAnyHostKey();
        private final EmbeddedSshServer server;
        private final AtomicInteger leases = new AtomicInteger();
        private final AtomicInteger discards = new AtomicInteger();

        Sessions(EmbeddedSshServer server) {
            this.server = server;
            toClose.add(client);
        }

        @Override
        public SessionAcquisition lease(RemoteTarget target, CancelToken cancel) {
            ClientSession session;
            try {
                session = client.open(server, USER, PASSWORD);
            } catch (IOException e) {
                return new SessionAcquisition.Unavailable(TransferFailureCause.CONNECT_FAILED);
            }
            leases.incrementAndGet();
            return new SessionAcquisition.Acquired(new SessionLease() {
                @Override
                public ClientSession session() {
                    return session;
                }

                @Override
                public void discard() {
                    discards.incrementAndGet();
                }

                @Override
                public void close() {
                    session.close(true);
                }
            });
        }
    }

    /** The installer on the embedded server with the doubles above. */
    private final class Bed {
        final EmbeddedSshServer server;
        final Sessions sessions;
        final TarExecutor executor = new TarExecutor(root);
        final WritingTransfer transfer = new WritingTransfer(root);
        final AgentCliInstaller installer;

        Bed(Clock clock) throws IOException {
            server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(root).start();
            toClose.add(server);
            sessions = new Sessions(server);
            installer = new AgentCliInstaller(executor, transfer, sessions, new SftpChannels(), JsonMapper.builder().build(), clock);
        }

        AgentCliInstallResult install(Release release) {
            return install(release, new ExecutionControl(new CancelSource(), () -> { }));
        }

        AgentCliInstallResult install(Release release, ExecutionControl control) {
            PayloadSource source = () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(release.bytes())), release.bytes().length);
            return installer.install(new AgentCliInstallRequest(TARGET, release.plan(), source, TransferLimits.defaults()), control);
        }
    }

    private Bed bed() throws IOException {
        return new Bed(Clock.systemUTC());
    }

    // ---- S3-AG-01 to S3-AG-04 ----

    @Test
    @DisplayName("S3-AG-01 S3-AG-10 D-0035 an installation: integrity, SFTP work, the package, one remote command (the unpack), the version read over SFTP, the switch read back, then Installed")
    void installation() throws IOException {
        Bed bed = bed();
        Release release = release("package one");

        AgentCliInstallResult result = bed.install(release);

        assertThat(result).isInstanceOf(AgentCliInstallResult.Installed.class);
        AgentCliInstallResult.Installed installed = (AgentCliInstallResult.Installed) result;
        assertThat(installed.version()).isEqualTo(new CliVersion("1.2.3"));
        assertThat(installed.cleanupFailures()).isZero();
        assertThat(bed.executor.commandLines).as("the only command sent to the target is the one the plan made for the unpack")
            .containsExactly(release.plan().commands().get(0).commandLine());
        assertThat(bed.transfer.requests).hasSize(1);
        assertThat(bed.transfer.requests.get(0).path().value()).isEqualTo("/.ssh-approval-portal/agent-cli/claude/versions/" + release.directory() + ".partial/package.tgz");
        assertThat(current()).isEqualTo(release.directory());
        assertThat(toolDirectory().resolve("versions").resolve(release.directory()).resolve("package/package.json")).exists();
        assertThat(toolDirectory().resolve("versions").resolve(release.directory() + ".partial")).doesNotExist();
        assertThat(bed.server.execRequests().size()).as("no exec request reached the server: the target's shell is the double").isZero();
    }

    @Test
    @DisplayName("S3-AG-02 RC-B-637 a package that is not the one the release announced is Refused(PACKAGE_INTEGRITY_MISMATCH) and nothing at all is sent to the target")
    void tamperedPackage() throws IOException {
        Bed bed = bed();
        Release release = release("package one");
        PayloadSource changed = () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream("changed bytes".getBytes(StandardCharsets.UTF_8))), 13);

        AgentCliInstallResult result = bed.installer.install(new AgentCliInstallRequest(TARGET, release.plan(), changed, TransferLimits.defaults()),
            new ExecutionControl(new CancelSource(), () -> { }));

        assertThat(result).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.PACKAGE_INTEGRITY_MISMATCH));
        assertThat(bed.sessions.leases.get()).isZero();
        assertThat(bed.executor.commandLines).isEmpty();
        assertThat(bed.transfer.requests).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-03 RC-B-633 a release that is already current is Reused: nothing is written, no command and no upload")
    void sameVersionIsReused() throws IOException {
        Bed bed = bed();
        Release release = release("package one");
        bed.install(release);

        AgentCliInstallResult again = bed.install(release);

        assertThat(again).isEqualTo(new AgentCliInstallResult.Reused(new CliVersion("1.2.3")));
        assertThat(bed.executor.commandLines).hasSize(1);
        assertThat(bed.transfer.requests).hasSize(1);
    }

    @Test
    @DisplayName("S3-AG-04 RC-B-636 an update keeps the previous version: its directory stays, current moves to the new one")
    void updateKeepsThePreviousVersion() throws IOException {
        Bed bed = bed();
        Release first = release("package one");
        Release second = release("package two");
        bed.install(first);

        AgentCliInstallResult result = bed.install(second);

        assertThat(result).isInstanceOf(AgentCliInstallResult.Installed.class);
        assertThat(current()).isEqualTo(second.directory());
        assertThat(toolDirectory().resolve("versions").resolve(first.directory()).resolve("package/package.json")).exists();
    }

    // ---- S3-AG-05, S3-AG-06: after the switch (D-0035) ----

    @Test
    @DisplayName("S3-AG-05 D-0035 a read-back of the new current that the server refuses puts the old current back: RolledBack, never Installed")
    void failedReadBackIsRolledBack() throws IOException {
        Bed bed = bed();
        Release first = release("package one");
        Release second = release("package two");
        bed.install(first);
        // Only the read of the release directory after the switch matches: the unpacking was read in the .partial directory.
        bed.server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, second.directory() + "/package/package.json", SftpFault.Failure.PERMISSION_DENIED).times(1));

        AgentCliInstallResult result = bed.install(second);

        assertThat(result).isInstanceOf(AgentCliInstallResult.RolledBack.class);
        assertThat(((AgentCliInstallResult.RolledBack) result).reason()).isEqualTo(AgentCliRefusal.INSTALL_COMMAND_FAILED);
        assertThat(current()).isEqualTo(first.directory());
    }

    @Test
    @DisplayName("S3-AG-05 a first installation that fails its read-back goes back to no current at all: RolledBack")
    void firstInstallationRolledBack() throws IOException {
        Bed bed = bed();
        Release release = release("package one");
        bed.server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, release.directory() + "/package/package.json", SftpFault.Failure.PERMISSION_DENIED).times(1));

        AgentCliInstallResult result = bed.install(release);

        assertThat(result).isInstanceOf(AgentCliInstallResult.RolledBack.class);
        assertThat(current()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-06 D-0035 a connection lost right after the switch is Unconfirmed(TransportLost): no Installed, no rollback sent over a connection that is gone, the session discarded")
    void connectionLostAfterTheSwitch() throws IOException {
        Bed bed = bed();
        Release release = release("package one");
        bed.server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, release.directory() + "/package/package.json", SftpFault.Failure.CONNECTION_DROPPED).times(1));

        AgentCliInstallResult result = bed.install(release);

        assertThat(result).isInstanceOf(AgentCliInstallResult.Unconfirmed.class);
        assertThat(((AgentCliInstallResult.Unconfirmed) result).cause()).isEqualTo(new UnconfirmedCause.TransportLost());
        assertThat(bed.sessions.discards.get()).isEqualTo(1);
        assertThat(current()).as("the switch had happened: nothing undid it over the dead connection").isEqualTo(release.directory());
        assertThat(bed.executor.commandLines).as("nothing was sent twice").hasSize(1);
    }

    @Test
    @DisplayName("S3-AG-06 D-0035 whatever the failure after the switch, the answer is never NotDispatched and never Installed")
    void nothingAfterTheSwitchIsNotDispatched() throws IOException {
        for (SftpFault.Failure failure : List.of(SftpFault.Failure.PERMISSION_DENIED, SftpFault.Failure.IO_ERROR, SftpFault.Failure.CONNECTION_DROPPED)) {
            Path directory = Files.createTempDirectory(root, "after-");
            try (EmbeddedSshServer server = EmbeddedSshServer.builder().password(USER, PASSWORD).sftp(directory).start()) {
                Sessions sessions = new Sessions(server);
                TarExecutor executor = new TarExecutor(directory);
                Release release = release("package one");
                server.injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, release.directory() + "/package/package.json", failure).times(1));
                AgentCliInstaller installer = new AgentCliInstaller(executor, new WritingTransfer(directory), sessions, new SftpChannels(), JsonMapper.builder().build(),
                    Clock.systemUTC());

                AgentCliInstallResult result = installer.install(new AgentCliInstallRequest(TARGET, release.plan(), () -> new PayloadRead(
                    Channels.newChannel(new ByteArrayInputStream(release.bytes())), release.bytes().length), TransferLimits.defaults()), new ExecutionControl(new CancelSource(), () -> { }));

                assertThat(result).as("%s", failure).isNotInstanceOf(AgentCliInstallResult.NotDispatched.class).isNotInstanceOf(AgentCliInstallResult.Installed.class);
                assertThat(executor.commandLines).as("the one command was sent once").hasSize(1);
            }
        }
    }

    // ---- S3-AG-08, S3-AG-09: clean-up and stops ----

    @Test
    @DisplayName("S3-AG-08 cleanupFailures counts the removals that failed: 0 is none, a positive number is how many")
    void cleanupFailures() throws IOException {
        Bed bed = bed();
        Release release = release("package one");
        bed.server.injectSftpFault(SftpFault.of(SftpFault.Operation.REMOVE, "package.tgz", SftpFault.Failure.PERMISSION_DENIED));

        AgentCliInstallResult result = bed.install(release);

        assertThat(result).isInstanceOf(AgentCliInstallResult.Installed.class);
        assertThat(((AgentCliInstallResult.Installed) result).cleanupFailures()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-AG-09 a cancel before the switch removes the partial directory, keeps the previous version and answers NotDispatched(CANCELLED); nothing is uploaded")
    void cancelBeforeTheSwitch() throws IOException {
        Bed bed = bed();
        Release first = release("package one");
        Release second = release("package two");
        bed.install(first);
        CancelSource cancel = new CancelSource();
        cancel.cancel();

        AgentCliInstallResult result = bed.install(second, new ExecutionControl(cancel, () -> { }));

        assertThat(result).isEqualTo(new AgentCliInstallResult.NotDispatched(TransferFailureCause.CANCELLED));
        assertThat(bed.transfer.requests).hasSize(1);
        assertThat(current()).isEqualTo(first.directory());
        assertThat(toolDirectory().resolve("versions").resolve(second.directory() + ".partial")).doesNotExist();
    }

    @Test
    @DisplayName("S3-AG-09 a time limit that has run out before the switch ends the installation the same way: NotDispatched(DEADLINE), partial directory removed")
    void deadlineBeforeTheSwitch() throws IOException {
        // The clock moves a second with every reading, so the 2 second limit of the request is over by the time the target has been looked at.
        Clock stepping = new Clock() {
            private Instant now = Instant.parse("2026-11-12T00:00:00Z");

            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                now = now.plusSeconds(1);
                return now;
            }
        };
        Bed bed = new Bed(stepping);
        Release release = release("package one");

        AgentCliInstallResult result = bed.installer.install(new AgentCliInstallRequest(TARGET, release.plan(),
            () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(release.bytes())), release.bytes().length),
            new TransferLimits(Duration.ofSeconds(2), TransferLimits.DEFAULT_MAX_FILE_SIZE)), new ExecutionControl(new CancelSource(), () -> { }));

        assertThat(result).isEqualTo(new AgentCliInstallResult.NotDispatched(TransferFailureCause.DEADLINE));
        assertThat(current()).isEmpty();
        assertThat(bed.executor.commandLines).isEmpty();
    }

    // ---- what goes wrong before the switch ----

    @Test
    @DisplayName("S3-AG-01 an unpack that ends with a failure is a refusal and the partial directory is removed; a missing tar (127) is PREREQUISITE_MISSING")
    void unpackProblems() throws IOException {
        Bed failing = bed();
        failing.executor.behaviour = new Unpacking.Exits(2);
        Release release = release("package one");

        AgentCliInstallResult failed = failing.install(release);
        failing.executor.behaviour = new Unpacking.Exits(127);
        AgentCliInstallResult missing = failing.install(release);

        assertThat(failed).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(missing).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.PREREQUISITE_MISSING));
        assertThat(toolDirectory().resolve("versions").resolve(release.directory() + ".partial")).doesNotExist();
        assertThat(current()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-01 a package whose metadata names another version, or is no JSON, is refused with the partial directory removed and current untouched")
    void metadataProblems() throws IOException {
        Bed bed = bed();
        Release release = release("package one");

        bed.executor.behaviour = new Unpacking.Works("{\"version\":\"9.9.9\"}");
        AgentCliInstallResult wrongVersion = bed.install(release);
        bed.executor.behaviour = new Unpacking.Works("this is not json");
        AgentCliInstallResult notJson = bed.install(release);

        assertThat(wrongVersion).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(notJson).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(toolDirectory().resolve("versions").resolve(release.directory() + ".partial")).doesNotExist();
        assertThat(current()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-01 an unpack whose end is not seen is Unconfirmed(TransportLost); it is not sent again")
    void unpackThatIsNotSeenToEnd() throws IOException {
        Bed bed = bed();
        bed.executor.behaviour = new Unpacking.Lost();

        AgentCliInstallResult result = bed.install(release("package one"));

        assertThat(result).isEqualTo(new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0));
        assertThat(bed.executor.commandLines).hasSize(1);
        assertThat(current()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-01 an upload that the target refused is a refusal with the partial directory removed; one whose end is not known is Unconfirmed with the cause of the upload")
    void uploadProblems() throws IOException {
        Bed refusing = bed();
        refusing.transfer.answer = new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new io.github.jaeseongs95.portal.app.remote.FileDiagnostic.None(), CleanupState.COMPLETE);
        Release release = release("package one");

        AgentCliInstallResult refused = refusing.install(release);
        refusing.transfer.answer = new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE);
        AgentCliInstallResult unknown = refusing.install(release);

        assertThat(refused).isEqualTo(new AgentCliInstallResult.Refused(AgentCliRefusal.INSTALL_COMMAND_FAILED));
        assertThat(unknown).isEqualTo(new AgentCliInstallResult.Unconfirmed(new UnconfirmedCause.TransportLost(), 0));
        assertThat(refusing.executor.commandLines).isEmpty();
    }

    // ---- status ----

    @Test
    @DisplayName("S3-AG-07 the status reads the version and the login over SFTP, and runs nothing: not installed, then installed and signed out, then signed in")
    void status() throws IOException {
        Bed bed = bed();
        AgentCliStatusRequest request = new AgentCliStatusRequest(TARGET, AgentCliProviderId.CLAUDE, ExecutionLimits.defaults());
        ExecutionControl control = new ExecutionControl(new CancelSource(), () -> { });

        AgentCliStatusResult before = bed.installer.status(request, control);
        bed.install(release("package one"));
        AgentCliStatusResult signedOut = bed.installer.status(request, control);
        Files.createDirectories(root.resolve(".claude"));
        Files.writeString(root.resolve(".claude/.credentials.json"), "{}", StandardCharsets.UTF_8);
        AgentCliStatusResult signedIn = bed.installer.status(request, control);

        assertThat(((AgentCliStatusResult.Observed) before).remote()).isEqualTo(new RemoteStatus.NotFound());
        assertThat(((AgentCliStatusResult.Observed) before).login()).isEqualTo(LoginState.NOT_INSTALLED);
        assertThat(((AgentCliStatusResult.Observed) signedOut).remote()).isEqualTo(new RemoteStatus.Known(RemoteState.COMPLETED, new CliVersion("1.2.3"), 0));
        assertThat(((AgentCliStatusResult.Observed) signedOut).login()).isEqualTo(LoginState.SIGNED_OUT);
        assertThat(((AgentCliStatusResult.Observed) signedIn).login()).isEqualTo(LoginState.SIGNED_IN);
        assertThat(bed.executor.commandLines).as("only the installation ran its one command; the status ran none").hasSize(1);
    }

    @Test
    @DisplayName("S3-SS-02 a session that cannot be had is NotDispatched(CONNECT_FAILED) for an installation and Failed(CONNECT_FAILED) for a status")
    void noSession() throws IOException {
        Bed bed = bed();
        bed.server.close();

        AgentCliInstallResult installed = bed.install(release("package one"));
        AgentCliStatusResult status = bed.installer.status(new AgentCliStatusRequest(TARGET, AgentCliProviderId.CLAUDE, ExecutionLimits.defaults()),
            new ExecutionControl(new CancelSource(), () -> { }));

        assertThat(installed).isEqualTo(new AgentCliInstallResult.NotDispatched(TransferFailureCause.CONNECT_FAILED));
        assertThat(status).isEqualTo(new AgentCliStatusResult.Failed(TransferFailureCause.CONNECT_FAILED));
    }
}
