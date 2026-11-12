package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.id.TargetId;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ProfileAlias;
import io.github.jaeseongs95.portal.domain.target.TargetLookup;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.common.SftpException;
import org.apache.sshd.sftp.common.extensions.openssh.PosixRenameExtensionParser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * The file adapter against a real OpenSSH server (S3-RO-03, S3-RO-04, S3-RW-02 to S3-RW-04; the real-server counterparts of the embedded-server tests). It runs only through
 * the Gradle task {@code realOpenSshTest}, on a machine where the CI preparation scripts started the server; nothing here was run on the machine that wrote it. The server's
 * system is data ({@link RealServer#isWindows()}), so the same tests run on Linux and on Windows and no test is skipped. Where one system has nothing to observe, the
 * test states what it checks instead. Each test works in a directory of its own in the home directory of the account and removes it.
 */
@Timeout(300)
class RealSftpTest {

    private final Sha256Digester digester = new Sha256Digester();
    private final ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
    private RealServer server;
    private MinaRemoteFileTransfer transfer;
    private String directoryName;
    private RemoteTarget target;

    @BeforeEach
    void connect() throws IOException {
        server = RealServer.open();
        scheduler.setDaemon(true);
        scheduler.initialize();
        SftpFailureClassifier classifier = new SftpFailureClassifier();
        RemotePathChecker checker = new RemotePathChecker((id, path) -> new PathPolicyDecision.NotApplicable(), classifier);
        AtomicReplacer replacer = new AtomicReplacer(checker, classifier, new SecureRandom(), Clock.systemUTC());
        SftpChannels channels = new SftpChannels();
        ElevationProbe probe = new ElevationProbe(server.executor(), id -> new TargetLookup.NotRegistered(id));
        transfer = new MinaRemoteFileTransfer(server.sessions(), channels, checker, new SftpUploader(checker, replacer, classifier, channels, new SpaceProbe()),
            new SftpDownloader(checker, classifier), classifier, new ElevatedExecTransfer(probe, server.executor(), replacer, Clock.systemUTC()), probe, scheduler, Clock.systemUTC());
        target = new RemoteTarget(new TargetId("realserver"), TargetRevision.of("b".repeat(64)), new ProfileAlias("writer"), AccessMode.READ_WRITE);
        directoryName = "ssh-approval-portal-test-" + HexFormat.of().formatHex(new SecureRandom().generateSeed(6));
        server.exec(server.isWindows() ? "cmd /c mkdir \"%USERPROFILE%\\" + directoryName + "\"" : "mkdir -p \"$HOME/" + directoryName + "\"");
    }

    @AfterEach
    void cleanUp() throws IOException {
        server.exec(server.isWindows() ? "cmd /c rmdir /s /q \"%USERPROFILE%\\" + directoryName + "\"" : "rm -rf \"$HOME/" + directoryName + "\"");
        server.close();
        scheduler.shutdown();
    }

    private ExecutionControl control() {
        return new ExecutionControl(new CancelSource(), () -> { });
    }

    private RemotePath path(String name) throws IOException {
        return server.homePath(directoryName + "/" + name);
    }

    private UploadRequest upload(RemotePath path, byte[] content, OverwriteMode mode) {
        return new UploadRequest(target, path, content.length, digester.digest(content), mode, new FileAccess.Direct(), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    private DownloadResult fetch(RemotePath path, java.io.ByteArrayOutputStream into) {
        return transfer.download(new DownloadRequest(target, path, new FileAccess.Direct(), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults()),
            data -> {
                into.write(data, 0, data.length);
                return new io.github.jaeseongs95.portal.app.remote.SinkResult.Accepted();
            }, control());
    }

    private static io.github.jaeseongs95.portal.app.remote.PayloadSource source(byte[] bytes) {
        return () -> new io.github.jaeseongs95.portal.app.storage.PayloadRead(Channels.newChannel(new ByteArrayInputStream(bytes)), bytes.length);
    }

    @Test
    @DisplayName("S3-RW-03 S3-RO-04 an upload and a download round trip over the real SFTP server: the bytes, the empty file, and the replacement of an existing file")
    void roundTrip() throws IOException {
        byte[] content = new byte[300_000];
        for (int index = 0; index < content.length; index++) {
            content[index] = (byte) (index * 7 + 1);
        }
        RemotePath file = path("a.bin");

        UploadResult created = transfer.upload(upload(file, content, OverwriteMode.FAIL_IF_EXISTS), source(content), control());
        java.io.ByteArrayOutputStream fetched = new java.io.ByteArrayOutputStream();
        DownloadResult read = fetch(file, fetched);

        assertThat(created).isInstanceOf(UploadResult.Published.class);
        assertThat(read).isEqualTo(new DownloadResult.Fetched(content.length, digester.digest(content)));
        assertThat(fetched.toByteArray()).isEqualTo(content);

        byte[] second = "replaced".getBytes(StandardCharsets.UTF_8);
        UploadResult replaced = transfer.upload(upload(file, second, OverwriteMode.REPLACE), source(second), control());
        assertThat(replaced).isInstanceOf(UploadResult.Published.class);
        java.io.ByteArrayOutputStream again = new java.io.ByteArrayOutputStream();
        fetch(file, again);
        assertThat(again.toByteArray()).isEqualTo(second);

        byte[] empty = new byte[0];
        RemotePath emptyFile = path("empty.bin");
        assertThat(transfer.upload(upload(emptyFile, empty, OverwriteMode.FAIL_IF_EXISTS), source(empty), control())).isInstanceOf(UploadResult.Published.class);
    }

    @Test
    @DisplayName("S3-RW-03 an existing file is kept when replacing is not allowed: DESTINATION_EXISTS with the original bytes")
    void destinationExists() throws IOException {
        RemotePath file = path("keep.bin");
        byte[] original = "original".getBytes(StandardCharsets.UTF_8);
        byte[] other = "refused".getBytes(StandardCharsets.UTF_8);
        transfer.upload(upload(file, original, OverwriteMode.FAIL_IF_EXISTS), source(original), control());

        UploadResult result = transfer.upload(upload(file, other, OverwriteMode.FAIL_IF_EXISTS), source(other), control());

        assertThat(result).isInstanceOf(UploadResult.Refused.class);
        assertThat(((UploadResult.Refused) result).code()).isEqualTo(TransferErrorCode.DESTINATION_EXISTS);
        java.io.ByteArrayOutputStream kept = new java.io.ByteArrayOutputStream();
        fetch(file, kept);
        assertThat(kept.toByteArray()).isEqualTo(original);
    }

    @Test
    @DisplayName("S3-RO-04 what a real server does with rename and posix-rename: the plain rename onto an existing file fails, posix-rename (when offered) replaces; the adapter uses what is offered")
    void renameAndPosixRename() throws IOException {
        try (SftpClient sftp = new SftpChannels().open(server.session())) {
            RemotePath one = path("one.bin");
            RemotePath two = path("two.bin");
            SftpLocation first = new SftpLocation(one);
            SftpLocation second = new SftpLocation(two);
            sftp.put(new ByteArrayInputStream("1".getBytes(StandardCharsets.UTF_8)), first.file());
            sftp.put(new ByteArrayInputStream("2".getBytes(StandardCharsets.UTF_8)), second.file());
            boolean offered = sftp.getServerExtensions().containsKey(PosixRenameExtensionParser.NAME);

            Throwable plain = org.assertj.core.api.Assertions.catchThrowable(() -> sftp.rename(first.file(), second.file()));
            assertThat(plain).as("a plain rename onto an existing file is refused by the server").isInstanceOf(SftpException.class);
            assertThat(new SftpFailureClassifier().classify((SftpException) plain).kind()).isIn(SftpFailure.Kind.PLAIN_FAILURE, SftpFailure.Kind.ALREADY_EXISTS);

            byte[] content = "three".getBytes(StandardCharsets.UTF_8);
            UploadResult replaced = transfer.upload(upload(two, content, OverwriteMode.REPLACE), source(content), control());
            assertThat(replaced).isInstanceOf(UploadResult.Published.class);
            assertThat(((UploadResult.Published) replaced).method()).isEqualTo(offered ? ReplaceMethod.POSIX_RENAME : ReplaceMethod.BACKUP_SWAP);
        }
    }

    @Test
    @DisplayName("S3-RW-02 the SFTP form of a path: the form the adapter sends is accepted by the server, and a server of the other form is shown by what stat answers")
    void pathForms() throws IOException {
        byte[] content = "x".getBytes(StandardCharsets.UTF_8);
        RemotePath file = path("form.bin");
        transfer.upload(upload(file, content, OverwriteMode.FAIL_IF_EXISTS), source(content), control());
        try (SftpClient sftp = new SftpChannels().open(server.session())) {
            String adapterForm = new SftpLocation(file).file();

            assertThat(sftp.stat(adapterForm).getSize()).isEqualTo(1);
            if (server.isWindows()) {
                // The Windows server is asked in the other forms as well, and the answers are the knowledge S3-RW-02 is for (the adapter keeps the first form).
                for (String form : new String[] {adapterForm.substring(1), adapterForm.substring(1).replace('/', '\\')}) {
                    boolean accepted;
                    try {
                        accepted = sftp.stat(form).getSize() == 1;
                    } catch (IOException e) {
                        accepted = false;
                    }
                    System.getLogger(RealSftpTest.class.getName()).log(System.Logger.Level.INFO, "Win32-OpenSSH stat of {0}: accepted={1}", form, accepted);
                }
            }
        }
    }

    @Test
    @DisplayName("S3-RW-04 a link or a junction as the file or as a directory of the path is UNSAFE_PATH, and what it points at is not touched")
    void linksAreUnsafe() throws IOException {
        byte[] original = "real".getBytes(StandardCharsets.UTF_8);
        RemotePath real = path("real.bin");
        transfer.upload(upload(real, original, OverwriteMode.FAIL_IF_EXISTS), source(original), control());
        String home = server.isWindows() ? "%USERPROFILE%\\" + directoryName : "$HOME/" + directoryName;
        if (server.isWindows()) {
            server.exec("cmd /c mkdir \"" + home + "\\realdir\" && mklink /J \"" + home + "\\linkdir\" \"" + home + "\\realdir\" && mklink \"" + home + "\\link.bin\" \"" + home
                + "\\real.bin\"");
        } else {
            server.exec("mkdir \"" + home + "/realdir\" && ln -s \"" + home + "/realdir\" \"" + home + "/linkdir\" && ln -s \"" + home + "/real.bin\" \"" + home + "/link.bin\"");
        }
        byte[] content = "through the link".getBytes(StandardCharsets.UTF_8);

        UploadResult asFile = transfer.upload(upload(path("link.bin"), content, OverwriteMode.REPLACE), source(content), control());
        UploadResult asDirectory = transfer.upload(upload(path("linkdir/x.bin"), content, OverwriteMode.FAIL_IF_EXISTS), source(content), control());

        // The server decides what it reports for a link (S3-RW-04 for Win32-OpenSSH): a refusal as unsafe is the result where it reports the link.
        assertThat(asFile).isInstanceOf(UploadResult.Refused.class);
        assertThat(((UploadResult.Refused) asFile).code()).isEqualTo(TransferErrorCode.UNSAFE_PATH);
        assertThat(asDirectory).isInstanceOf(UploadResult.Refused.class);
        assertThat(((UploadResult.Refused) asDirectory).code()).isEqualTo(TransferErrorCode.UNSAFE_PATH);
        java.io.ByteArrayOutputStream kept = new java.io.ByteArrayOutputStream();
        fetch(real, kept);
        assertThat(kept.toByteArray()).isEqualTo(original);
    }

    @Test
    @DisplayName("S3-RO-03 D-0013 D-0034 a file the account may not read is PERMISSION_DENIED (not a transport error); a write that fails for lack of space is not read as a permission problem either")
    void statusCodesOfARealServer() throws IOException {
        byte[] content = "secret".getBytes(StandardCharsets.UTF_8);
        RemotePath file = path("secret.bin");
        transfer.upload(upload(file, content, OverwriteMode.FAIL_IF_EXISTS), source(content), control());
        AtomicInteger observed = new AtomicInteger(-1);
        if (!server.isWindows()) {
            server.exec("chmod 000 \"$HOME/" + directoryName + "/secret.bin\"");
            DownloadResult denied = fetch(file, new java.io.ByteArrayOutputStream());
            assertThat(denied).isInstanceOf(DownloadResult.Refused.class);
            assertThat(((DownloadResult.Refused) denied).code()).isEqualTo(TransferErrorCode.PERMISSION_DENIED);
            // /dev/full answers every write with ENOSPC: the status the real sftp-server gives for it is whatever it is, and it must not be taken for permission or transport.
            try (SftpClient sftp = new SftpChannels().open(server.session())) {
                Throwable failure = org.assertj.core.api.Assertions.catchThrowable(() -> {
                    try (java.io.OutputStream out = sftp.write("/dev/full")) {
                        out.write(new byte[4096]);
                    }
                });
                assertThat(failure).isInstanceOf(IOException.class);
                SftpFailure classified = new SftpFailureClassifier().classify((IOException) failure);
                observed.set(classified.status());
                assertThat(classified.kind()).isIn(SftpFailure.Kind.NO_SPACE, SftpFailure.Kind.PLAIN_FAILURE);
            }
        }
        System.getLogger(RealSftpTest.class.getName()).log(System.Logger.Level.INFO, "sftp-server status for a write to /dev/full: {0}", observed.get());
    }
}
