package io.github.jaeseongs95.portal.ssh.sftp;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FilePathPolicy;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.PayloadSink;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.RemoteExecutor;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.SinkResult;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.app.target.TargetSource;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import io.github.jaeseongs95.portal.ssh.testkit.EmbeddedSshServer;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.nio.file.Files;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.server.command.CommandFactory;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * Everything a file test needs, wired the way the application wires it: an embedded SSH server with an SFTP root, a session source, the adapter and its
 * collaborators, a scheduler for the deadlines. A test builds one with {@link #start} and closes it. The remote path {@code /x.bin} is the file {@code x.bin} in
 * {@link #root()}, so a test prepares and reads the target with {@code java.nio} on the server side.
 */
final class TransferBed implements AutoCloseable {

    static final RemoteTarget TARGET = new RemoteTarget(new TargetId("files"), TargetRevision.of("a".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);

    private final Path root;
    private final EmbeddedSshServer server;
    private final TestSessions sessions;
    private final ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
    private final AtomicReplacer replacer;
    private final MinaRemoteFileTransfer transfer;
    private final Sha256Digester digester = new Sha256Digester();

    /** The program the test target's {@link SudoSftpChannels} looks for, and the command line that starts it under {@code sudo -n}. */
    static final String SUDO_SERVER = "/usr/lib/openssh/sftp-server";
    static final String SUDO_COMMAND = "sudo -n " + SUDO_SERVER;

    /** What the test target offers for elevated file work. */
    enum Sudo {
        /** No SFTP server program in the usual places. */
        NO_SERVER,
        /** The program is there and {@code sudo -n} does not start it (the command fails at once, as for an account that needs a password). */
        DENIED,
        /** The program is there and {@code sudo -n} starts an SFTP server (here the server of the test target itself). */
        WORKS
    }

    private TransferBed(Path root, boolean posixRename, SftpChannels channels, RemoteExecutor executor, FilePathPolicy policy, Sudo sudo, List<HiddenLinkProbe> linkProbes)
        throws IOException {
        this.root = root;
        if (sudo != Sudo.NO_SERVER) {
            Files.createDirectories(root.resolve("usr/lib/openssh"));
            Files.writeString(root.resolve("usr/lib/openssh/sftp-server"), "not a program: the test target only has to show a regular file there");
        }
        EmbeddedSshServer.Builder builder = EmbeddedSshServer.builder().password(TestSessions.USER, TestSessions.PASSWORD).sftp(root).sftpAdvertisesPosixRename(posixRename);
        if (sudo == Sudo.WORKS) {
            builder.customize(sshd -> {
                CommandFactory original = sshd.getCommandFactory();
                SftpSubsystemFactory subsystem = new SftpSubsystemFactory.Builder().build();
                sshd.setCommandFactory((channel, command) -> SUDO_COMMAND.equals(command) ? subsystem.createSubsystem(channel) : original.createCommand(channel, command));
            });
        }
        this.server = builder.start();
        this.sessions = new TestSessions(server);
        scheduler.setDaemon(true);
        scheduler.setPoolSize(1);
        scheduler.initialize();
        SftpFailureClassifier classifier = new SftpFailureClassifier();
        RemotePathChecker checker = new RemotePathChecker(policy, classifier);
        this.replacer = new AtomicReplacer(checker, classifier, new SecureRandom(), Clock.systemUTC());
        SpaceProbe spaceProbe = new SpaceProbe();
        SftpUploader uploader = new SftpUploader(checker, replacer, classifier, channels, spaceProbe);
        SftpDownloader downloader = new SftpDownloader(checker, classifier);
        TargetSource noTargets = id -> new TargetLookup.NotRegistered(id);
        ElevationProbe probe = new ElevationProbe(executor, noTargets);
        SudoSftpChannels sudoChannels = new SudoSftpChannels(channels, List.of(SUDO_SERVER));
        this.transfer = new MinaRemoteFileTransfer(sessions, channels, checker, uploader, downloader, classifier, sudoChannels, probe, scheduler, Clock.systemUTC(),
            linkProbes);
    }

    /** A bed with the MINA SFTP channel, a policy that does not apply and an executor that runs nothing. */
    static TransferBed start(Path root, boolean posixRename) throws IOException {
        return start(root, posixRename, new SftpChannels(), ScriptedExecutor.everythingSucceeds(), (target, path) -> new PathPolicyDecision.NotApplicable());
    }

    static TransferBed start(Path root, boolean posixRename, SftpChannels channels, RemoteExecutor executor, FilePathPolicy policy) throws IOException {
        return new TransferBed(root, posixRename, channels, executor, policy, Sudo.NO_SERVER, List.of());
    }

    /** A bed with link probes: the checks for the links that the SFTP server of a target does not show. */
    static TransferBed start(Path root, List<HiddenLinkProbe> linkProbes) throws IOException {
        return new TransferBed(root, true, new SftpChannels(), ScriptedExecutor.everythingSucceeds(), (target, path) -> new PathPolicyDecision.NotApplicable(), Sudo.NO_SERVER,
            linkProbes);
    }

    /** A bed whose target offers (or does not offer) elevated file work through an SFTP server under {@code sudo -n}; the executor is the one of the probes. */
    static TransferBed start(Path root, Sudo sudo, RemoteExecutor executor) throws IOException {
        return new TransferBed(root, true, new SftpChannels(), executor, (target, path) -> new PathPolicyDecision.NotApplicable(), sudo, List.of());
    }

    Path root() {
        return root;
    }

    EmbeddedSshServer server() {
        return server;
    }

    TestSessions sessions() {
        return sessions;
    }

    MinaRemoteFileTransfer transfer() {
        return transfer;
    }

    AtomicReplacer replacer() {
        return replacer;
    }

    Digest sha256(byte[] bytes) {
        return digester.digest(bytes);
    }

    /** A control whose cancel nobody calls and whose guard lets everything pass. */
    ExecutionControl control() {
        return new ExecutionControl(new CancelSource(), () -> { });
    }

    ExecutionControl control(CancelSource cancel) {
        return new ExecutionControl(cancel, () -> { });
    }

    /** An upload request for a POSIX path on the test target: the announced size and digest are those of {@code content}. */
    UploadRequest upload(String path, byte[] content, OverwriteMode overwrite) {
        return upload(new PosixRemotePath(path), content, overwrite, new FileAccess.Direct(), TransferLimits.defaults());
    }

    UploadRequest upload(RemotePath path, byte[] content, OverwriteMode overwrite, FileAccess access, TransferLimits limits) {
        return new UploadRequest(TARGET, path, content.length, sha256(content), overwrite, access, new PathPolicyBinding.NoRootPolicy(), limits);
    }

    DownloadRequest download(String path) {
        return new DownloadRequest(TARGET, new PosixRemotePath(path), new FileAccess.Direct(), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    DownloadRequest download(String path, TransferLimits limits) {
        return new DownloadRequest(TARGET, new PosixRemotePath(path), new FileAccess.Direct(), new PathPolicyBinding.NoRootPolicy(), limits);
    }

    static PayloadSource source(byte[] bytes) {
        return () -> new PayloadRead(Channels.newChannel(new ByteArrayInputStream(bytes)), bytes.length);
    }

    /** A time limit of the given length with the default file size limit. */
    static TransferLimits within(Duration deadline) {
        return new TransferLimits(deadline, TransferLimits.DEFAULT_MAX_FILE_SIZE);
    }

    /** Collects what a download delivers. */
    static final class Collecting implements PayloadSink {
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private final AtomicInteger calls = new AtomicInteger();
        private final Runnable onFirstCall;

        Collecting() {
            this(() -> { });
        }

        /** A sink that runs {@code onFirstCall} when the first block arrives, before it takes the block. */
        Collecting(Runnable onFirstCall) {
            this.onFirstCall = onFirstCall;
        }

        @Override
        public SinkResult append(byte[] data) {
            if (calls.getAndIncrement() == 0) {
                onFirstCall.run();
            }
            bytes.write(data, 0, data.length);
            return new SinkResult.Accepted();
        }

        byte[] bytes() {
            return bytes.toByteArray();
        }
    }

    @Override
    public void close() throws IOException {
        sessions.close();
        server.close();
        scheduler.shutdown();
    }
}
