package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

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
import io.github.jaeseongs95.portal.app.remote.PathPolicyDecision;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.ReplaceMethod;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
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
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * Elevated file work (S3-EL-01 to S3-EL-04, stage 3 design 6.1, decision Q8): a POSIX target is served by fixed {@code sudo -n} commands (the fallback until pilot P3-4
 * shows the SFTP server started with {@code sudo -n}), a Windows target by the administrator probe and then the same SFTP work. Which of the two is chosen is a fact of
 * the {@link ElevationPlan} in the request, not of an operating system test in the adapter. The executor is a plain test class that runs nothing and records every
 * command line.
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

    private TransferBed start(ScriptedExecutor executor) throws IOException {
        bed = TransferBed.start(root, true, new SftpChannels(), executor, (target, path) -> new PathPolicyDecision.NotApplicable());
        return bed;
    }

    private static ScriptedExecutor.Answer exits(int code) {
        return new ScriptedExecutor.Answer.Exits(code, "");
    }

    private UploadRequest elevatedUpload(String path, OverwriteMode overwrite, ElevationPlan plan) {
        return bed.upload(new PosixRemotePath(path), CONTENT, overwrite, new FileAccess.Elevated(plan), TransferLimits.defaults());
    }

    /** An executor that answers each fixed command by what it starts with: the rules are checked in order. */
    private static ScriptedExecutor executor(Function<String, ScriptedExecutor.Answer> rule) {
        return new ScriptedExecutor(rule);
    }

    private static boolean isWrite(String commandLine) {
        return commandLine.startsWith("sudo -n sh -c 'umask 077; set -C; cat");
    }

    private static boolean isPlace(String commandLine) {
        return commandLine.contains("sha256sum");
    }

    // ---- S3-EL-01: the sudo -n fallback ----

    @Test
    @DisplayName("S3-EL-01 an elevated upload on a POSIX target: probe, write to a temporary file, check and put in place; the commands are fixed text and the path is one quoted word")
    void elevatedUploadSequence() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/opt/it's here/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(((UploadResult.Published) result).method()).isEqualTo(ReplaceMethod.POSIX_RENAME);
        assertThat(((UploadResult.Published) result).sha256()).isEqualTo(testBed.sha256(CONTENT));
        List<ScriptedExecutor.Run> runs = executor.runs();
        assertThat(runs).hasSize(3);
        assertThat(runs.get(0).commandLine()).isEqualTo("sudo -n true");
        assertThat(isWrite(runs.get(1).commandLine())).isTrue();
        assertThat(runs.get(1).stdin()).as("the bytes travel as standard input, not in the command line").isEqualTo(CONTENT);
        assertThat(runs.get(1).commandLine()).contains("'/opt/it'\\''s here/.ssh-approval-").endsWith(".part'");
        assertThat(isPlace(runs.get(2).commandLine())).isTrue();
        assertThat(runs.get(2).commandLine()).contains("'" + testBed.sha256(CONTENT).hex() + "'").contains("'" + CONTENT.length + "'").contains("'/opt/it'\\''s here/x.bin'")
            .endsWith("'replace'");
        assertThat(runs).allSatisfy(run -> assertThat(run.commandLine()).doesNotContain(new String(CONTENT, StandardCharsets.UTF_8)));
        assertThat(testBed.sessions().leases()).as("the fallback is exec only: no SFTP session").isZero();
    }

    @Test
    @DisplayName("S3-EL-01 where the target must not be replaced the command links the file in place, which fails when it exists: NO_CLOBBER_RENAME")
    void elevatedUploadThatMustNotReplace() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/opt/x.bin", OverwriteMode.FAIL_IF_EXISTS, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(((UploadResult.Published) result).method()).isEqualTo(ReplaceMethod.NO_CLOBBER_RENAME);
        assertThat(executor.commandLines().get(2)).endsWith("'fail'");
    }

    @Test
    @DisplayName("S3-EL-01 a digest or size that differs on the target is FILE_CHANGED and the temporary file is removed; the target exists is DESTINATION_EXISTS and it is removed too")
    void elevatedUploadRefusals() throws IOException {
        for (int exit : new int[] {21, 22}) {
            ScriptedExecutor executor = executor(commandLine -> isPlace(commandLine) ? exits(exit) : exits(0));
            try (TransferBed testBed = TransferBed.start(Files.createTempDirectory(root, "e-"), true, new SftpChannels(), executor,
                (target, path) -> new PathPolicyDecision.NotApplicable())) {
                UploadResult result = testBed.transfer().upload(
                    testBed.upload(new PosixRemotePath("/opt/x.bin"), CONTENT, OverwriteMode.FAIL_IF_EXISTS, new FileAccess.Elevated(SUDO), TransferLimits.defaults()),
                    TransferBed.source(CONTENT), testBed.control());

                TransferErrorCode expected = exit == 21 ? TransferErrorCode.FILE_CHANGED : TransferErrorCode.DESTINATION_EXISTS;
                assertThat(result).as("exit %d", exit).isEqualTo(new UploadResult.Refused(expected, new FileDiagnostic.None(), CleanupState.COMPLETE));
                assertThat(executor.commandLines().get(executor.commandLines().size() - 1)).startsWith("sudo -n rm -f -- '/opt/.ssh-approval-");
            }
        }
    }

    @Test
    @DisplayName("S3-EL-01 D-0035 a step whose end is not seen leaves the result unknown, never Published; a temporary file that cannot be removed is named")
    void elevatedUploadUnknowns() throws IOException {
        ScriptedExecutor lostAtPlace = executor(commandLine -> isPlace(commandLine) ? new ScriptedExecutor.Answer.Lost() : exits(0));
        TransferBed testBed = start(lostAtPlace);

        UploadResult lost = testBed.transfer().upload(elevatedUpload("/opt/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(lost).isEqualTo(new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE));

        ScriptedExecutor cleanupFails = executor(commandLine -> isPlace(commandLine) ? exits(23) : exits(0));
        try (TransferBed other = TransferBed.start(Files.createTempDirectory(root, "e-"), true, new SftpChannels(), cleanupFails, (target, path) -> new PathPolicyDecision.NotApplicable())) {
            UploadResult unremoved = other.transfer().upload(
                other.upload(new PosixRemotePath("/opt/x.bin"), CONTENT, OverwriteMode.FAIL_IF_EXISTS, new FileAccess.Elevated(SUDO), TransferLimits.defaults()),
                TransferBed.source(CONTENT), other.control());

            assertThat(unremoved).isInstanceOf(UploadResult.Unconfirmed.class);
            assertThat(((UploadResult.Unconfirmed) unremoved).cause()).isInstanceOf(UnconfirmedCause.CleanupUnconfirmed.class);
            assertThat(((UploadResult.Unconfirmed) unremoved).cleanup()).isEqualTo(CleanupState.INCOMPLETE);
        }
    }

    @Test
    @DisplayName("S3-EL-02 sudo that needs a password is refused before anything is written: PERMISSION_DENIED, one command (the probe) was sent")
    void sudoDenied() throws IOException {
        ScriptedExecutor executor = executor(commandLine -> exits(1));
        TransferBed testBed = start(executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/opt/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(executor.commandLines()).containsExactly("sudo -n true");
    }

    @Test
    @DisplayName("S3-EL-02 a probe that cannot be run is not a refusal: NotDispatched with the reason")
    void probeThatCannotRun() throws IOException {
        TransferBed testBed = start(executor(commandLine -> new ScriptedExecutor.Answer.NotSent()));

        UploadResult result = testBed.transfer().upload(elevatedUpload("/opt/x.bin", OverwriteMode.REPLACE, SUDO), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.CHANNEL_OPEN_FAILED));
    }

    @Test
    @DisplayName("S3-EL-01 an elevated download: the size is asked first, then the bytes are read; a missing file and a link are refused with their codes")
    void elevatedDownload() throws IOException {
        TransferBed testBed = start(executor(commandLine -> {
            if (commandLine.contains("wc -c")) {
                return new ScriptedExecutor.Answer.Exits(0, "5\n");
            }
            if (commandLine.startsWith("sudo -n cat -- ")) {
                return new ScriptedExecutor.Answer.Exits(0, "hello");
            }
            return exits(0);
        }));
        TransferBed.Collecting sink = new TransferBed.Collecting();

        DownloadResult result = testBed.transfer().download(new io.github.jaeseongs95.portal.app.remote.DownloadRequest(TransferBed.TARGET, new PosixRemotePath("/root/a.txt"),
            new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults()), sink, testBed.control());

        assertThat(result).isEqualTo(new DownloadResult.Fetched(5, testBed.sha256("hello".getBytes(StandardCharsets.UTF_8))));
        assertThat(sink.bytes()).isEqualTo("hello".getBytes(StandardCharsets.UTF_8));
        assertThat(testBed.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-EL-01 an elevated download of a missing file (exit 31) is FILE_NOT_FOUND, of a link or a directory (exit 30) UNSAFE_PATH, one that is too large is TooLarge")
    void elevatedDownloadRefusals() throws IOException {
        for (int exit : new int[] {31, 30}) {
            try (TransferBed testBed = TransferBed.start(Files.createTempDirectory(root, "d-"), true, new SftpChannels(),
                executor(commandLine -> commandLine.contains("wc -c") ? exits(exit) : exits(0)), (target, path) -> new PathPolicyDecision.NotApplicable())) {
                DownloadResult result = testBed.transfer().download(new io.github.jaeseongs95.portal.app.remote.DownloadRequest(TransferBed.TARGET, new PosixRemotePath("/root/a.txt"),
                    new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults()), new TransferBed.Collecting(), testBed.control());

                assertThat(result).isEqualTo(new DownloadResult.Refused(exit == 31 ? TransferErrorCode.FILE_NOT_FOUND : TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None()));
            }
        }
        try (TransferBed testBed = TransferBed.start(Files.createTempDirectory(root, "d-"), true, new SftpChannels(),
            executor(commandLine -> commandLine.contains("wc -c") ? new ScriptedExecutor.Answer.Exits(0, "2000\n") : exits(0)), (target, path) -> new PathPolicyDecision.NotApplicable())) {
            TransferLimits small = new TransferLimits(TransferLimits.DEFAULT_DEADLINE, org.springframework.util.unit.DataSize.ofBytes(1000));

            DownloadResult result = testBed.transfer().download(new io.github.jaeseongs95.portal.app.remote.DownloadRequest(TransferBed.TARGET, new PosixRemotePath("/root/a.txt"),
                new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), small), new TransferBed.Collecting(), testBed.control());

            assertThat(result).isEqualTo(new DownloadResult.TooLarge(2000, 1000));
        }
    }

    @Test
    @DisplayName("S3-SF-12 elevated permission bits are read back: the mode the target reports must be the one asked for")
    void elevatedPermissions() throws IOException {
        TransferBed testBed = start(executor(commandLine -> commandLine.contains("chmod") ? new ScriptedExecutor.Answer.Exits(0, "640\n") : exits(0)));
        PermissionRequest request = new PermissionRequest(TransferBed.TARGET, new PosixRemotePath("/etc/app.conf"), new FileMode(0640), new PermissionSupport.Supported(),
            new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
        PermissionRequest other = new PermissionRequest(TransferBed.TARGET, new PosixRemotePath("/etc/app.conf"), new FileMode(0600), new PermissionSupport.Supported(),
            new FileAccess.Elevated(SUDO), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());

        assertThat(testBed.transfer().applyPermissions(request, testBed.control())).isEqualTo(new PermissionResult.Applied());
        assertThat(testBed.transfer().applyPermissions(other, testBed.control()))
            .isEqualTo(new PermissionResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None()));
    }

    // ---- S3-EL-03, S3-EL-04: the plan decides ----

    @Test
    @DisplayName("S3-EL-03 S3-EL-04 RC-B-616 a Windows connection that is the administrator's is granted and the file work is the same SFTP work: the probe is the only command")
    void administratorGranted() throws IOException {
        ScriptedExecutor executor = ScriptedExecutor.everythingSucceeds();
        TransferBed testBed = start(executor);

        UploadResult result = testBed.transfer().upload(elevatedUpload("/admin.bin", OverwriteMode.FAIL_IF_EXISTS, ADMINISTRATOR), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isInstanceOf(UploadResult.Published.class);
        assertThat(Files.readAllBytes(root.resolve("admin.bin"))).isEqualTo(CONTENT);
        assertThat(executor.commandLines()).containsExactly("powershell.exe -NoLogo admin-probe");
        assertThat(testBed.sessions().leases()).as("this plan is served over SFTP").isEqualTo(1);
    }

    @Test
    @DisplayName("S3-EL-03 RC-B-616 a connection that is not the administrator's is refused before the transfer: PERMISSION_DENIED, nothing written, no SFTP session")
    void administratorDenied() throws IOException {
        TransferBed testBed = start(executor(commandLine -> exits(1)));

        UploadResult result = testBed.transfer().upload(elevatedUpload("/admin.bin", OverwriteMode.FAIL_IF_EXISTS, ADMINISTRATOR), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(root.resolve("admin.bin")).doesNotExist();
        assertThat(testBed.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-EL-03 S3-EL-04 the probe's exit code is the whole answer: 0 grants, another code denies, a probe that does not end is Unavailable, a plan without elevation has no target here")
    void checkElevation() throws IOException {
        TransferBed granted = start(ScriptedExecutor.everythingSucceeds());
        ElevationRequest sudoRequest = new ElevationRequest(TransferBed.TARGET, SUDO, ExecutionLimits.defaults());
        assertThat(granted.transfer().checkElevation(sudoRequest, granted.control())).isEqualTo(new ElevationResult.Granted());
        granted.close();

        TransferBed denied = start(executor(commandLine -> exits(1)));
        assertThat(denied.transfer().checkElevation(sudoRequest, denied.control())).isEqualTo(new ElevationResult.Denied());
        denied.close();

        TransferBed lost = start(executor(commandLine -> new ScriptedExecutor.Answer.Lost()));
        assertThat(lost.transfer().checkElevation(new ElevationRequest(TransferBed.TARGET, ADMINISTRATOR, ExecutionLimits.defaults()), lost.control()))
            .isEqualTo(new ElevationResult.Unavailable(TransferFailureCause.TRANSPORT_LOST));
        lost.close();

        TransferBed none = start(ScriptedExecutor.everythingSucceeds());
        assertThat(none.transfer().checkElevation(new ElevationRequest(TransferBed.TARGET, new ElevationPlan.NotSupported(), ExecutionLimits.defaults()), none.control()))
            .isEqualTo(new ElevationResult.Unavailable(TransferFailureCause.CONNECT_FAILED));
        assertThat(none.sessions().leases()).isZero();
    }
}
