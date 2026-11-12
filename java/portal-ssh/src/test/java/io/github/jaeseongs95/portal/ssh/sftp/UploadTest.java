package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.PayloadSource;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.app.storage.PayloadRead;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.ssh.testkit.SftpFault;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.ReadableByteChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Stream;
import org.apache.sshd.sftp.client.SftpClient;
import org.apache.sshd.sftp.client.SftpClientFactory;
import org.apache.sshd.sftp.client.SftpVersionSelector;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.task.SimpleAsyncTaskExecutor;

/**
 * The upload over the embedded SFTP server (S3-SF-01 to S3-SF-05, S3-SF-10, S3-SF-13, S3-SF-16 to S3-SF-18, S3-SF-20; defects D-0035 and D-0034). Every test says what
 * the result is and what the target and its directory hold afterwards.
 */
@Timeout(120)
class UploadTest {

    private static final byte[] OLD = "the content that was there before".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @TempDir
    Path root;

    private TransferBed bed;

    @AfterEach
    void closeBed() throws IOException {
        if (bed != null) {
            bed.close();
        }
    }

    private TransferBed start(boolean posixRename) throws IOException {
        bed = TransferBed.start(root, posixRename);
        return bed;
    }

    private static byte[] pattern(int length) {
        byte[] bytes = new byte[length];
        for (int index = 0; index < length; index++) {
            bytes[index] = (byte) (index * 31 + 7);
        }
        return bytes;
    }

    private List<String> leftovers() throws IOException {
        try (Stream<Path> files = Files.list(root)) {
            return files.map(file -> file.getFileName().toString()).filter(name -> name.startsWith(".ssh-approval-")).toList();
        }
    }

    private boolean fileSystemHasPosixModes() throws IOException {
        return Files.getFileStore(root).supportsFileAttributeView(PosixFileAttributeView.class);
    }

    // ---- S3-SF-01: a new file ----

    @Test
    @DisplayName("S3-SF-01 a new 1 MiB file: temporary name, then rename; the bytes are the announced ones, no temporary file is left, and the answer is Published")
    void newFile() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024 * 1024);

        UploadResult result = testBed.transfer().upload(testBed.upload("/new.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        UploadResult.Published published = (UploadResult.Published) result;
        assertThat(published.sha256()).isEqualTo(testBed.sha256(content));
        assertThat(published.method()).isEqualTo(ReplaceMethod.NO_CLOBBER_RENAME);
        assertThat(Files.readAllBytes(root.resolve("new.bin"))).isEqualTo(content);
        assertThat(leftovers()).isEmpty();
        assertThat(testBed.sessions().leases()).as("one session, nothing sent twice").isEqualTo(1);
        assertThat(testBed.sessions().discards()).isZero();
    }

    @Test
    @DisplayName("S3-SF-01 the temporary file is 0600 and so is the new file where the file system has POSIX modes (the owner only)")
    void newFileIsOwnerOnly() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(2048);

        UploadResult result = testBed.transfer().upload(testBed.upload("/private.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        // A file system without POSIX modes (NTFS on the developer's PC) has none to show; the server then ignores the request, which the adapter accepts.
        if (fileSystemHasPosixModes()) {
            assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(root.resolve("private.bin")))).isEqualTo("rw-------");
        }
    }

    @Test
    @DisplayName("S3-SF-01 an empty file is published")
    void emptyFile() throws IOException {
        TransferBed testBed = start(true);

        UploadResult result = testBed.transfer().upload(testBed.upload("/empty.bin", new byte[0], OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(new byte[0]), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(Files.size(root.resolve("empty.bin"))).isZero();
    }

    // ---- S3-SF-02, S3-SF-03: replacing ----

    @Test
    @DisplayName("S3-SF-02 RC-B-615 an existing file is replaced when that is allowed: posix-rename, one step, the new bytes")
    void replaceWithPosixRename() throws IOException {
        TransferBed testBed = start(true);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(4096);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(((UploadResult.Published) result).method()).isEqualTo(ReplaceMethod.POSIX_RENAME);
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(content);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-02 a replaced file keeps the mode it had where the file system has POSIX modes")
    void replacedFileKeepsItsMode() throws IOException {
        TransferBed testBed = start(true);
        Path target = root.resolve("shared.bin");
        Files.write(target, OLD);
        if (fileSystemHasPosixModes()) {
            Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-r-----"));
        }
        byte[] content = pattern(512);

        UploadResult result = testBed.transfer().upload(testBed.upload("/shared.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        if (fileSystemHasPosixModes()) {
            assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(target))).isEqualTo("rw-r-----");
        }
    }

    @Test
    @DisplayName("RC-B-615 an existing file is kept when replacing is not allowed: DESTINATION_EXISTS, the old bytes stay, nothing is written")
    void destinationExists() throws IOException {
        TransferBed testBed = start(true);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(512);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.DESTINATION_EXISTS, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(OLD);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-03 D-0035 without posix-rename the original goes to a backup name, the new file is renamed in and the backup is removed")
    void replaceWithBackupSwap() throws IOException {
        TransferBed testBed = start(false);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(8192);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(((UploadResult.Published) result).method()).isEqualTo(ReplaceMethod.BACKUP_SWAP);
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(content);
        assertThat(leftovers()).as("neither the temporary nor the backup file is left").isEmpty();
    }

    // ---- S3-SF-04, S3-SF-05: what fails after the replacement (D-0035) ----

    @Test
    @DisplayName("S3-SF-04 D-0035 a failing second rename of the backup swap puts the original back: RolledBack, the old bytes, no Published")
    void failedSecondRenameRestoresTheOriginal() throws IOException {
        TransferBed testBed = start(false);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(8192);
        // The rename of the temporary file (its name ends in .part) fails once; the rename of the target to its backup and back have other names.
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.RENAME, ".part", SftpFault.Failure.IO_ERROR).times(1));

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.RolledBack.class);
        assertThat(result).isNotInstanceOf(UploadResult.Published.class);
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(OLD);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-05 D-0035 (a) a read-back of the replacement that fails: where a backup exists the original is restored, RolledBack, no Published")
    void failedReadBackRestoresTheOriginal() throws IOException {
        TransferBed testBed = start(false);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(8192);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, "out.bin", SftpFault.Failure.PERMISSION_DENIED).times(1));

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.RolledBack.class);
        assertThat(((UploadResult.RolledBack) result).code()).isEqualTo(TransferErrorCode.PERMISSION_DENIED);
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(OLD);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-05 D-0035 (a) with the one-step replacement there is no original to put back: a failed read-back is Unconfirmed, never Published")
    void failedReadBackAfterPosixRenameIsUnconfirmed() throws IOException {
        TransferBed testBed = start(true);
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(8192);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, "out.bin", SftpFault.Failure.PERMISSION_DENIED).times(1));

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Unconfirmed.class);
        assertThat(((UploadResult.Unconfirmed) result).cause()).isInstanceOf(UnconfirmedCause.DurabilityUnconfirmed.class);
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).as("the replacement stays; the owner decides").isEqualTo(content);
    }

    @Test
    @DisplayName("S3-SF-05 D-0035 (a) a new file whose read-back fails is removed again: the original state (no file) is confirmed, RolledBack")
    void failedReadBackOfANewFileRemovesIt() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_READ, "fresh.bin", SftpFault.Failure.PERMISSION_DENIED).times(1));

        UploadResult result = testBed.transfer().upload(testBed.upload("/fresh.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.RolledBack.class);
        assertThat(root.resolve("fresh.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-05 D-0035 (b) a flush that is tried and fails after the replacement: Unconfirmed(DurabilityUnconfirmed), never Published; the file stays in place")
    void failedFlushIsUnconfirmed() throws IOException {
        FlushRefusingChannels channels = new FlushRefusingChannels();
        bed = TransferBed.start(root, true, channels, ScriptedExecutor.everythingSucceeds(), (target, path) -> new io.github.jaeseongs95.portal.app.remote.PathPolicyDecision.NotApplicable());
        byte[] content = pattern(4096);

        UploadResult result = bed.transfer().upload(bed.upload("/flush.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), bed.control());

        assertThat(result).isEqualTo(new UploadResult.Unconfirmed(new UnconfirmedCause.DurabilityUnconfirmed(), CleanupState.COMPLETE));
        assertThat(Files.readAllBytes(root.resolve("flush.bin"))).isEqualTo(content);
        assertThat(channels.flushesTried()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SF-05 D-0035 a server that does not offer the flush is no reason for doubt: Published, and no flush is tried")
    void aFlushThatIsNotOfferedIsNotTried() throws IOException {
        FlushRefusingChannels channels = new FlushRefusingChannels(false);
        bed = TransferBed.start(root, true, channels, ScriptedExecutor.everythingSucceeds(), (target, path) -> new io.github.jaeseongs95.portal.app.remote.PathPolicyDecision.NotApplicable());
        byte[] content = pattern(4096);

        UploadResult result = bed.transfer().upload(bed.upload("/noflush.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), bed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(channels.flushesTried()).isZero();
    }

    // ---- S3-SF-10: the reasons of a failed write ----

    @Test
    @DisplayName("S3-SF-10 D-0034 a full file system in the middle of the transfer is STAGING_UNAVAILABLE with the NoSpace fact, not PERMISSION_DENIED; the temporary file is gone")
    void noSpace() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024 * 1024);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_WRITE, ".part", SftpFault.Failure.NO_SPACE).afterBytes(100_000));

        UploadResult result = testBed.transfer().upload(testBed.upload("/big.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.STAGING_UNAVAILABLE, new FileDiagnostic.NoSpace(), CleanupState.COMPLETE));
        assertThat(root.resolve("big.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-10 RC-B-512 a directory that refuses the write is PERMISSION_DENIED and the target is not touched")
    void permissionDenied() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_WRITE, ".part", SftpFault.Failure.PERMISSION_DENIED));

        UploadResult result = testBed.transfer().upload(testBed.upload("/denied.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Refused.class);
        assertThat(((UploadResult.Refused) result).code()).isEqualTo(TransferErrorCode.PERMISSION_DENIED);
        assertThat(root.resolve("denied.bin")).doesNotExist();
    }

    @Test
    @DisplayName("S3-EX-09 D-0013 a connection cut in the middle of the transfer is Unconfirmed(TransportLost), the session is discarded and nothing is leased a second time")
    void connectionLostInTheMiddle() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024 * 1024);
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.OPEN_FOR_WRITE, ".part", SftpFault.Failure.CONNECTION_DROPPED).afterBytes(100_000));

        UploadResult result = testBed.transfer().upload(testBed.upload("/cut.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE));
        assertThat(testBed.sessions().discards()).isEqualTo(1);
        assertThat(testBed.sessions().leases()).as("no automatic second attempt").isEqualTo(1);
        assertThat(root.resolve("cut.bin")).doesNotExist();
    }

    // ---- S3-SF-13: dangerous paths ----

    @Test
    @DisplayName("S3-SF-13 a directory where the file should be is UNSAFE_PATH and stays as it is")
    void directoryLeaf() throws IOException {
        TransferBed testBed = start(true);
        Files.createDirectory(root.resolve("out.bin"));
        Files.write(root.resolve("out.bin").resolve("inner.txt"), OLD);
        byte[] content = pattern(256);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(Files.readAllBytes(root.resolve("out.bin").resolve("inner.txt"))).isEqualTo(OLD);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-13 a file where a directory of the path should be is UNSAFE_PATH; a missing directory is PARENT_NOT_FOUND")
    void parentThatIsNotADirectory() throws IOException {
        TransferBed testBed = start(true);
        Files.write(root.resolve("plain"), OLD);
        byte[] content = pattern(256);

        UploadResult notADirectory = testBed.transfer().upload(testBed.upload("/plain/x.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());
        UploadResult missing = testBed.transfer().upload(testBed.upload("/nowhere/x.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

        assertThat(notADirectory).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(((UploadResult.Refused) missing).code()).isEqualTo(TransferErrorCode.PARENT_NOT_FOUND);
        assertThat(Files.readAllBytes(root.resolve("plain"))).isEqualTo(OLD);
    }

    @Test
    @DisplayName("S3-SF-13 a path with dot parts is not a path at all: the domain refuses it before any adapter sees it")
    void dotPartsAreRefusedByTheType() {
        assertThatThrownBy(() -> new PosixRemotePath("/a/../b.bin")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PosixRemotePath("/a/./b.bin")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("S3-SF-13 a link as the file or as a directory of the path is UNSAFE_PATH and neither the link nor what it points at is changed")
    void links() throws IOException {
        TransferBed testBed = start(true);
        Files.write(root.resolve("real.bin"), OLD);
        Files.createDirectory(root.resolve("realdir"));
        boolean linked = createLink(root.resolve("link.bin"), root.resolve("real.bin")) && createLink(root.resolve("linkdir"), root.resolve("realdir"));
        byte[] content = pattern(256);

        // Without the right to make links (Windows without developer mode) there is no link to test here; the Linux build runs this part.
        if (linked) {
            UploadResult asFile = testBed.transfer().upload(testBed.upload("/link.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());
            UploadResult asDirectory = testBed.transfer().upload(testBed.upload("/linkdir/x.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), testBed.control());

            assertThat(asFile).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
            assertThat(asDirectory).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
            assertThat(Files.readAllBytes(root.resolve("real.bin"))).isEqualTo(OLD);
            assertThat(root.resolve("realdir").resolve("x.bin")).doesNotExist();
        }
    }

    private static boolean createLink(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException e) {
            return false;
        }
    }

    // ---- what the stream is, and what the server holds ----

    @Test
    @DisplayName("S3-SF-20 D-0035 a byte changed on the server's side is found when the temporary file is read back: FILE_CHANGED, the target is unchanged, the temporary file is removed")
    void tamperedTemporaryFile() throws IOException {
        TamperingChannels channels = new TamperingChannels();
        bed = TransferBed.start(root, true, channels, ScriptedExecutor.everythingSucceeds(), (target, path) -> new io.github.jaeseongs95.portal.app.remote.PathPolicyDecision.NotApplicable());
        Files.write(root.resolve("out.bin"), OLD);
        byte[] content = pattern(4096);

        UploadResult result = bed.transfer().upload(bed.upload("/out.bin", content, OverwriteMode.REPLACE), TransferBed.source(content), bed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(Files.readAllBytes(root.resolve("out.bin"))).isEqualTo(OLD);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-20 a stored file that is not what was announced (another digest, another size) is FILE_CHANGED and nothing is put in place")
    void sourceIsNotTheAnnouncedFile() throws IOException {
        TransferBed testBed = start(true);
        byte[] announced = pattern(2048);
        byte[] other = pattern(2048);
        other[100] ^= 1;
        UploadRequest request = testBed.upload("/out.bin", announced, OverwriteMode.FAIL_IF_EXISTS);

        UploadResult sameSizeOtherBytes = testBed.transfer().upload(request, TransferBed.source(other), testBed.control());
        UploadResult shorter = testBed.transfer().upload(request, TransferBed.source(pattern(2000)), testBed.control());

        assertThat(sameSizeOtherBytes).isEqualTo(new UploadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(shorter).isEqualTo(new UploadResult.Refused(TransferErrorCode.FILE_CHANGED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(root.resolve("out.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-20 a file above the size limit of the request is refused before a connection is made")
    void aboveTheSizeLimit() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(2048);
        UploadRequest request = testBed.upload(new PosixRemotePath("/out.bin"), content, OverwriteMode.FAIL_IF_EXISTS, new FileAccess.Direct(),
            new TransferLimits(TransferLimits.DEFAULT_DEADLINE, org.springframework.util.unit.DataSize.ofBytes(2047)));

        UploadResult result = testBed.transfer().upload(request, TransferBed.source(content), testBed.control());

        assertThat(((UploadResult.Refused) result).code()).isEqualTo(TransferErrorCode.INVALID_REQUEST);
        assertThat(testBed.sessions().leases()).isZero();
    }

    // ---- S3-SF-16, S3-SF-17: two writers, and the clean-up ----

    @Test
    @DisplayName("S3-SF-16 RC-B-924 two uploads to the same new name at the same time: exactly one is Published, the other is DESTINATION_EXISTS, and the file is one of the two")
    void concurrentPublish() throws Exception {
        TransferBed testBed = start(true);
        byte[] first = pattern(300_000);
        byte[] second = new byte[300_000];
        java.util.Arrays.fill(second, (byte) 9);
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("upload-");

        CompletableFuture<UploadResult> one = CompletableFuture.supplyAsync(
            () -> testBed.transfer().upload(testBed.upload("/race.bin", first, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(first), testBed.control()), executor);
        CompletableFuture<UploadResult> other = CompletableFuture.supplyAsync(
            () -> testBed.transfer().upload(testBed.upload("/race.bin", second, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(second), testBed.control()), executor);
        List<UploadResult> results = List.of(one.get(), other.get());

        assertThat(results.stream().filter(result -> result instanceof UploadResult.Published).count()).as("published, results: %s", results).isEqualTo(1);
        assertThat(results.stream().filter(result -> result instanceof UploadResult.Refused refused && refused.code() == TransferErrorCode.DESTINATION_EXISTS).count())
            .as("destination exists, results: %s", results).isEqualTo(1);
        byte[] held = Files.readAllBytes(root.resolve("race.bin"));
        assertThat(held).isIn(first, second);
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-SF-17 a temporary file that cannot be removed after a refusal is named in Unconfirmed(CleanupUnconfirmed) and the cleanup is INCOMPLETE")
    void cleanupThatFails() throws IOException {
        TransferBed testBed = start(true);
        byte[] announced = pattern(2048);
        byte[] other = pattern(2048);
        other[5] ^= 1;
        testBed.server().injectSftpFault(SftpFault.of(SftpFault.Operation.REMOVE, ".part", SftpFault.Failure.PERMISSION_DENIED));

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", announced, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(other), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Unconfirmed.class);
        UploadResult.Unconfirmed unconfirmed = (UploadResult.Unconfirmed) result;
        assertThat(unconfirmed.cleanup()).isEqualTo(CleanupState.INCOMPLETE);
        assertThat(unconfirmed.cause()).isInstanceOf(UnconfirmedCause.CleanupUnconfirmed.class);
        String named = ((UnconfirmedCause.CleanupUnconfirmed) unconfirmed.cause()).leftoverName();
        assertThat(named).startsWith(".ssh-approval-").endsWith(".part");
        assertThat(leftovers()).containsExactly(named);
    }

    // ---- S3-SF-18: the SFTP version ----

    @Test
    @DisplayName("S3-SF-18 on SFTP version 3, what OpenSSH speaks, no step needs a newer version: new file, replace with posix-rename and replace by backup swap all work")
    void worksOnSftpVersionThree() throws IOException {
        for (boolean posixRename : new boolean[] {true, false}) {
            Path directory = Files.createTempDirectory(root, "v3-");
            try (TransferBed versionThree = TransferBed.start(directory, posixRename, new VersionThreeChannels(), ScriptedExecutor.everythingSucceeds(),
                (target, path) -> new io.github.jaeseongs95.portal.app.remote.PathPolicyDecision.NotApplicable())) {
                byte[] first = pattern(5000);
                byte[] second = pattern(6000);

                UploadResult created = versionThree.transfer().upload(versionThree.upload("/a.bin", first, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(first),
                    versionThree.control());
                UploadResult replaced = versionThree.transfer().upload(versionThree.upload("/a.bin", second, OverwriteMode.REPLACE), TransferBed.source(second),
                    versionThree.control());

                assertThat(created).as("posix-rename offered: %s", posixRename).isInstanceOf(UploadResult.Published.class);
                assertThat(replaced).as("posix-rename offered: %s", posixRename).isInstanceOf(UploadResult.Published.class);
                assertThat(((UploadResult.Published) replaced).method()).isEqualTo(posixRename ? ReplaceMethod.POSIX_RENAME : ReplaceMethod.BACKUP_SWAP);
                assertThat(Files.readAllBytes(directory.resolve("a.bin"))).isEqualTo(second);
            }
        }
    }

    // ---- stops from outside ----

    @Test
    @DisplayName("S3-EX-03 a cancel that was asked before the upload starts is NotDispatched(CANCELLED): nothing is written")
    void cancelBeforeTheStart() throws IOException {
        TransferBed testBed = start(true);
        CancelSource cancel = new CancelSource();
        cancel.cancel();
        byte[] content = pattern(1024);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control(cancel));

        assertThat(result).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.CANCELLED));
        assertThat(root.resolve("out.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-09 a cancel in the middle of the transfer ends it before the replacement: the temporary file is removed with a channel of its own, NotDispatched(CANCELLED)")
    void cancelInTheMiddle() throws IOException {
        TransferBed testBed = start(true);
        CancelSource cancel = new CancelSource();
        byte[] content = pattern(1024 * 1024);
        PayloadSource cancelling = () -> new PayloadRead(new TriggeringChannel(Channels.newChannel(new ByteArrayInputStream(content)), 3, cancel::cancel), content.length);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.FAIL_IF_EXISTS), cancelling, testBed.control(cancel));

        assertThat(result).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.CANCELLED));
        assertThat(root.resolve("out.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
    }

    @Test
    @DisplayName("S3-AG-09 the time limit ends a slow upload before the replacement: the temporary file is removed, NotDispatched(DEADLINE)")
    void deadline() throws Exception {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024 * 1024);
        CountDownLatch released = new CountDownLatch(1);
        // The source stalls on its third block until a task of the scheduler lets it go, long after the 150 millisecond limit.
        PayloadSource slow = () -> new PayloadRead(new TriggeringChannel(Channels.newChannel(new ByteArrayInputStream(content)), 3, () -> awaitQuietly(released)), content.length);
        org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler releaser = new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();
        releaser.setDaemon(true);
        releaser.initialize();
        try {
            releaser.schedule(released::countDown, Clock.systemUTC().instant().plusMillis(800));

            UploadResult result = testBed.transfer().upload(testBed.upload(new PosixRemotePath("/out.bin"), content, OverwriteMode.FAIL_IF_EXISTS, new FileAccess.Direct(),
                TransferBed.within(Duration.ofMillis(150))), slow, testBed.control());

            assertThat(result).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.DEADLINE));
            assertThat(root.resolve("out.bin")).doesNotExist();
            assertThat(leftovers()).isEmpty();
        } finally {
            releaser.shutdown();
        }
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    @DisplayName("RC-B-608 a guard that refuses before the dispatch stops the upload with nothing written and the exception of the guard")
    void guardRefuses() throws IOException {
        TransferBed testBed = start(true);
        byte[] content = pattern(1024);
        io.github.jaeseongs95.portal.app.remote.ExecutionControl refusing = new io.github.jaeseongs95.portal.app.remote.ExecutionControl(new CancelSource(), () -> {
            throw new io.github.jaeseongs95.portal.domain.error.DispatchRefusedException(io.github.jaeseongs95.portal.domain.error.DispatchFailure.refused(
                io.github.jaeseongs95.portal.domain.error.DispatchReason.TARGET_CHANGED, io.github.jaeseongs95.portal.domain.error.DispatchStage.TARGET_GUARD));
        });

        assertThatThrownBy(() -> testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), refusing))
            .isInstanceOf(io.github.jaeseongs95.portal.domain.error.DispatchRefusedException.class);

        assertThat(root.resolve("out.bin")).doesNotExist();
        assertThat(leftovers()).isEmpty();
        assertThat(testBed.sessions().leases()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SS-02 a session that cannot be had is NotDispatched(CONNECT_FAILED): nothing is written")
    void noSession() throws IOException {
        TransferBed testBed = start(true);
        testBed.server().close();
        byte[] content = pattern(1024);

        UploadResult result = testBed.transfer().upload(testBed.upload("/out.bin", content, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(content), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.CONNECT_FAILED));
    }

    // ---- the doubles of this file ----

    /** A channel that runs {@code action} when the n-th read is asked for (a cancel, a stall), then reads on. */
    private static final class TriggeringChannel implements ReadableByteChannel {
        private final ReadableByteChannel delegate;
        private final int onRead;
        private final Runnable action;
        private int reads;

        TriggeringChannel(ReadableByteChannel delegate, int onRead, Runnable action) {
            this.delegate = delegate;
            this.onRead = onRead;
            this.action = action;
        }

        @Override
        public int read(ByteBuffer destination) throws IOException {
            if (++reads == onRead) {
                action.run();
            }
            return delegate.read(destination);
        }

        @Override
        public boolean isOpen() {
            return delegate.isOpen();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }

    /** Opens the SFTP channel at version 3, as OpenSSH's sftp-server speaks it. */
    private static final class VersionThreeChannels extends SftpChannels {
        @Override
        public SftpClient open(org.apache.sshd.client.session.ClientSession session) throws IOException {
            return SftpClientFactory.instance().createSftpClient(session, SftpVersionSelector.fixedVersionSelector(3));
        }
    }

    private static final class TamperingChannels extends SftpChannels {
        private final SftpDoubles doubles = new SftpDoubles();

        @Override
        public SftpClient open(org.apache.sshd.client.session.ClientSession session) throws IOException {
            return doubles.tamperingWhenReading(super.open(session), ".part");
        }
    }

    /** Opens a client whose flush (fsync@openssh.com) fails, or one that does not offer it. */
    private static final class FlushRefusingChannels extends SftpChannels {
        private final boolean offered;
        private final SftpDoubles doubles = new SftpDoubles();
        private final SftpDoubles.FlushCounter counter = new SftpDoubles.FlushCounter();

        FlushRefusingChannels() {
            this(true);
        }

        FlushRefusingChannels(boolean offered) {
            this.offered = offered;
        }

        int flushesTried() {
            return counter.tried();
        }

        @Override
        public SftpClient open(org.apache.sshd.client.session.ClientSession session) throws IOException {
            return doubles.refusingToFlush(super.open(session), offered, counter);
        }
    }
}
