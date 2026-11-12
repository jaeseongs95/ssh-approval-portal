package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ElevationRequest;
import io.github.jaeseongs95.portal.app.remote.ElevationResult;
import io.github.jaeseongs95.portal.app.remote.ExecutionLimits;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.FileMode;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * Elevated file work (S3-EL-01 to S3-EL-04, stage 3 design 6.1, decision Q8). A POSIX target is served by its SFTP server started with {@code sudo -n} and spoken to with
 * MINA's own client over an {@code exec} channel ({@link SudoSftpChannels}); the transfer code is the one of a plain transfer, so every check, replacement and result of the
 * other tests holds here too. A Windows target is served by the administrator probe and then the plain channel. Which of the two is chosen is a fact of the
 * {@link ElevationPlan} in the request, not of an operating-system test in the adapter. The test target stands in for {@code sudo -n} with its own SFTP server on the
 * command line {@code sudo -n /usr/lib/openssh/sftp-server}; whether a real {@code sudo} does the same is shown by the real-server tests (S3-RO-02).
 * The executor of the probes is a plain test class that runs nothing and records every command line.
 */
@Timeout(120)
class ElevatedTransferTest {

    private static final byte[] CONTENT = "the bytes of an elevated upload".getBytes(StandardCharsets.UTF_8);
    private static final ElevationPlan SUDO = new ElevationPlan.SudoNonInteractive(new FixedRemoteCommand("sudo-probe", "sudo -n true"));
    private static final ElevationPlan ADMINISTRATOR = new ElevationPlan.WindowsAdministratorCheck(new FixedRemoteCommand("admin-probe", "powershell.exe -NoLogo admin-probe"));

    @TempDir
    Path root;

    private TransferBed bed;

    @AfterEach
    void closeBed() throws IOException {
        if (bed != null) {
            bed.close();
        }
    }

    private TransferBed start(TransferBed.Sudo sudo, ScriptedExecutor executor) throws IOException {
        bed = TransferBed.start(root, sudo, executor);
        return bed;
    }

    private UploadRequest elevatedUpload(String path, OverwriteMode overwrite, ElevationPlan plan) {
        return bed.upload(new PosixRemotePath(path), CONTENT, overwrite, new FileAccess.Elevated(plan), TransferLimits.defaults());
    }

    private DownloadRequest elevatedDownload(String path) {
        return new DownloadRequest(TransferBed.TARGET, new PosixRemotePath(path), new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    // ---- S3-EL-01: the SFTP server under sudo -n ----

    @Test
    @DisplayName("S3-EL-01 an elevated upload on a POSIX target runs the same code over the SFTP server started with sudo -n: Published, the bytes, no temporary file, no command of the executor")
    void elevatedUpload() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(TransferBed.Sudo.WORKS, executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/elevated.bin", OverwriteMode.FAIL_IF_EXISTS, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(((UploadResult.Published) result).sha256()).isEqualTo(testBed.sha256(CONTENT));
        assertThat(Files.readAllBytes(root.resolve("elevated.bin"))).isEqualTo(CONTENT);
        try (var files = Files.list(root)) {
            assertThat(files.map(file -> file.getFileName().toString()).filter(name -> name.startsWith(".ssh-approval-"))).isEmpty();
        }
        assertThat(executor.commandLines()).as("the file work needs no remote command but the start of the server").isEmpty();
        assertThat(testBed.sessions().leases()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EL-01 the replacement of an existing file is the adapter's own: posix-rename in one step, and a file that must not be replaced is DESTINATION_EXISTS")
    void elevatedReplacement() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.WORKS, ScriptedExecutor.everythingSucceeds());
        Files.write(root.resolve("existing.bin"), "old".getBytes(StandardCharsets.UTF_8));

        UploadResult kept = testBed.transfer().upload(elevatedUpload("/existing.bin", OverwriteMode.FAIL_IF_EXISTS, SUDO), TransferBed.source(CONTENT), testBed.control());
        UploadResult replaced = testBed.transfer().upload(elevatedUpload("/existing.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(kept).isEqualTo(new UploadResult.Refused(TransferErrorCode.DESTINATION_EXISTS, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(replaced).isInstanceOf(UploadResult.Published.class);
        assertThat(((UploadResult.Published) replaced).method()).isEqualTo(ReplaceMethod.POSIX_RENAME);
        assertThat(Files.readAllBytes(root.resolve("existing.bin"))).isEqualTo(CONTENT);
    }

    @Test
    @DisplayName("S3-EL-01 an elevated upload meets the same path checks: a directory where the file should be is UNSAFE_PATH, a missing directory is PARENT_NOT_FOUND, and the file size is not held in memory")
    void elevatedPathChecks() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.WORKS, ScriptedExecutor.everythingSucceeds());
        Files.createDirectory(root.resolve("folder"));

        UploadResult directory = testBed.transfer().upload(elevatedUpload("/folder", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());
        UploadResult missing = testBed.transfer().upload(elevatedUpload("/nowhere/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(directory).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(((UploadResult.Refused) missing).code()).isEqualTo(TransferErrorCode.PARENT_NOT_FOUND);
    }

    @Test
    @DisplayName("S3-EL-01 an elevated download reads the file over the same channel and checks it like a plain one")
    void elevatedDownload() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.WORKS, ScriptedExecutor.everythingSucceeds());
        Files.write(root.resolve("secret.txt"), CONTENT);
        TransferBed.Collecting sink = new TransferBed.Collecting();

        DownloadResult result = testBed.transfer().download(elevatedDownload("/secret.txt"), sink, testBed.control());
        DownloadResult missing = testBed.transfer().download(elevatedDownload("/missing.txt"), new TransferBed.Collecting(), testBed.control());

        assertThat(result).isEqualTo(new DownloadResult.Fetched(CONTENT.length, testBed.sha256(CONTENT)));
        assertThat(sink.bytes()).isEqualTo(CONTENT);
        assertThat(missing).isEqualTo(new DownloadResult.Refused(TransferErrorCode.FILE_NOT_FOUND, new FileDiagnostic.None()));
    }

    @Test
    @DisplayName("S3-SF-12 elevated permission bits are set and read back by the same code; where the file system has no POSIX modes the read-back says so")
    void elevatedPermissions() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.WORKS, ScriptedExecutor.everythingSucceeds());
        Path file = root.resolve("app.conf");
        Files.write(file, CONTENT);
        PermissionRequest request = new PermissionRequest(TransferBed.TARGET, new PosixRemotePath("/app.conf"), new FileMode(0640), new PermissionSupport.Supported(),
            new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());

        PermissionResult result = testBed.transfer().applyPermissions(request, testBed.control());

        if (Files.getFileStore(root).supportsFileAttributeView(PosixFileAttributeView.class)) {
            assertThat(result).isEqualTo(new PermissionResult.Applied());
            assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-r-----");
        } else {
            assertThat(result).isEqualTo(new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None()));
        }
    }

    // ---- S3-EL-02: no elevation ----

    @Test
    @DisplayName("S3-EL-02 sudo that cannot start the server (a password is needed) refuses the request before anything is written: PERMISSION_DENIED")
    void sudoDenied() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.DENIED, ScriptedExecutor.everythingSucceeds());

        UploadResult upload = testBed.transfer().upload(elevatedUpload("/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());
        DownloadResult download = testBed.transfer().download(elevatedDownload("/x.bin"), new TransferBed.Collecting(), testBed.control());

        assertThat(upload).isEqualTo(new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(download).isEqualTo(new DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None()));
        assertThat(root.resolve("x.bin")).doesNotExist();
    }

    @Test
    @DisplayName("S3-EL-02 a target without an SFTP server program in the usual places has no elevated file work: the request is refused as invalid, nothing is written")
    void noServerProgram() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.NO_SERVER, ScriptedExecutor.everythingSucceeds());

        UploadResult result = testBed.transfer().upload(elevatedUpload("/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(root.resolve("x.bin")).doesNotExist();
    }

    // ---- S3-EL-03, S3-EL-04: the plan decides ----

    @Test
    @DisplayName("S3-EL-03 S3-EL-04 RC-B-616 a Windows connection that is the administrator's is granted and the file work is the plain SFTP work: the probe is the only command")
    void administratorGranted() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(TransferBed.Sudo.NO_SERVER, executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/admin.bin", OverwriteMode.FAIL_IF_EXISTS, ADMINISTRATOR), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(Files.readAllBytes(root.resolve("admin.bin"))).isEqualTo(CONTENT);
        assertThat(executor.commandLines()).containsExactly("powershell.exe -NoLogo admin-probe");
    }

    @Test
    @DisplayName("S3-EL-03 RC-B-616 a connection that is not the administrator's is refused before the transfer: PERMISSION_DENIED, nothing written, no SFTP session")
    void administratorDenied() throws IOException {
        TransferBed testBed = start(TransferBed.Sudo.NO_SERVER, new ScriptedExecutor(commandLine -> new ScriptedExecutor.Answer.Exits(1, "")));

        UploadResult result = testBed.transfer().upload(elevatedUpload("/admin.bin", OverwriteMode.FAIL_IF_EXISTS, ADMINISTRATOR), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(root.resolve("admin.bin")).doesNotExist();
        assertThat(testBed.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-EL-04 the plan decides the route: a sudo plan never runs the Windows probe, a Windows plan never starts a sudo server")
    void planDecidesTheRoute() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(TransferBed.Sudo.WORKS, executor);

        testBed.transfer().upload(elevatedUpload("/a.bin", OverwriteMode.FAIL_IF_EXISTS, SUDO), TransferBed.source(CONTENT), testBed.control());
        assertThat(executor.commandLines()).isEmpty();

        testBed.transfer().upload(elevatedUpload("/b.bin", OverwriteMode.FAIL_IF_EXISTS, ADMINISTRATOR), TransferBed.source(CONTENT), testBed.control());
        assertThat(executor.commandLines()).containsExactly("powershell.exe -NoLogo admin-probe");
        assertThat(Files.readAllBytes(root.resolve("b.bin"))).isEqualTo(CONTENT);
    }

    @Test
    @DisplayName("S3-EL-03 S3-EL-04 the probe's exit code is the whole answer: 0 grants, another code denies, a probe that does not end is Unavailable, a plan without elevation has no target here")
    void checkElevation() throws IOException {
        TransferBed granted = start(TransferBed.Sudo.NO_SERVER, ScriptedExecutor.everythingSucceeds());
        ElevationRequest sudoRequest = new ElevationRequest(TransferBed.TARGET, SUDO, ExecutionLimits.defaults());
        assertThat(granted.transfer().checkElevation(sudoRequest, granted.control())).isEqualTo(new ElevationResult.Granted());
        granted.close();

        TransferBed denied = start(TransferBed.Sudo.NO_SERVER, new ScriptedExecutor(commandLine -> new ScriptedExecutor.Answer.Exits(1, "")));
        assertThat(denied.transfer().checkElevation(sudoRequest, denied.control())).isEqualTo(new ElevationResult.Denied());
        denied.close();

        TransferBed lost = start(TransferBed.Sudo.NO_SERVER, new ScriptedExecutor(commandLine -> new ScriptedExecutor.Answer.Lost()));
        assertThat(lost.transfer().checkElevation(new ElevationRequest(TransferBed.TARGET, ADMINISTRATOR, ExecutionLimits.defaults()), lost.control()))
            .isEqualTo(new ElevationResult.Unavailable(TransferFailureCause.TRANSPORT_LOST));
        lost.close();

        TransferBed none = start(TransferBed.Sudo.NO_SERVER, ScriptedExecutor.everythingSucceeds());
        assertThat(none.transfer().checkElevation(new ElevationRequest(TransferBed.TARGET, new ElevationPlan.NotSupported(), ExecutionLimits.defaults()), none.control()))
            .isEqualTo(new ElevationResult.Unavailable(TransferFailureCause.CONNECT_FAILED));
        assertThat(none.sessions().leases()).isZero();
    }
}
