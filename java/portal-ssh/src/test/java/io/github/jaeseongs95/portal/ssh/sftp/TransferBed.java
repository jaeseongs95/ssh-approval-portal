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
import java.util.concurrent.atomic.AtomicInteger;
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

    private TransferBed(Path root, boolean posixRename, SftpChannels channels, RemoteExecutor executor, FilePathPolicy policy) throws IOException {
        this.root = root;
        this.server = EmbeddedSshServer.builder().password(TestSessions.USER, TestSessions.PASSWORD).sftp(root).sftpAdvertisesPosixRename(posixRename).start();
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
        ElevatedExecTransfer elevated = new ElevatedExecTransfer(probe, executor, replacer, Clock.systemUTC());
        this.transfer = new MinaRemoteFileTransfer(sessions, channels, checker, uploader, downloader, classifier, elevated, probe, scheduler, Clock.systemUTC());
    }

    /** A bed with the MINA SFTP channel, a policy that does not apply and an executor that runs nothing. */
    static TransferBed start(Path root, boolean posixRename) throws IOException {
        return start(root, posixRename, new SftpChannels(), ScriptedExecutor.everythingSucceeds(), (target, path) -> new PathPolicyDecision.NotApplicable());
    }

    static TransferBed start(Path root, boolean posixRename, SftpChannels channels, RemoteExecutor executor, FilePathPolicy policy) throws IOException {
        return new TransferBed(root, posixRename, channels, executor, policy);
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
