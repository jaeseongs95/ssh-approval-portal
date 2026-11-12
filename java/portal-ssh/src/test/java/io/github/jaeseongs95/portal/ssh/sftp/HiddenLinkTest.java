package io.github.jaeseongs95.portal.ssh.sftp;

import static org.assertj.core.api.Assertions.assertThat;

import io.github.jaeseongs95.portal.app.remote.DownloadRequest;
import io.github.jaeseongs95.portal.app.remote.DownloadResult;
import io.github.jaeseongs95.portal.app.remote.ElevationPlan;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.FileMode;
import io.github.jaeseongs95.portal.app.remote.FixedRemoteCommand;
import io.github.jaeseongs95.portal.app.remote.PathPolicyBinding;
import io.github.jaeseongs95.portal.app.remote.PermissionRequest;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.PermissionSupport;
import io.github.jaeseongs95.portal.app.remote.RemoteTarget;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.TransferLimits;
import io.github.jaeseongs95.portal.app.remote.UploadRequest;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.path.RemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/**
 * The links that the SFTP server of a Windows target does not show (S3-RW-04, defect found by the real-server test; the reason is in {@link HiddenLinkProbe}): a junction on
 * the way to the file. The probe is a plain test class that answers what the test says and counts how often it was asked; what the real command does on a real server is
 * shown by the real-server test. Every operation (upload, download, permission bits, with the administrator plan too) is refused before a session is leased.
 */
@Timeout(120)
class HiddenLinkTest {

    private static final byte[] CONTENT = "through the junction".getBytes(StandardCharsets.UTF_8);
    private static final WindowsRemotePath THROUGH_JUNCTION = new WindowsRemotePath("C:\\work\\linkdir\\x.bin");

    @TempDir
    Path root;

    private TransferBed bed;

    @AfterEach
    void closeBed() throws IOException {
        if (bed != null) {
            bed.close();
        }
    }

    /** A probe for Windows paths that answers the same to every path and counts the questions. */
    private static final class FixedProbe implements HiddenLinkProbe {
        private final Verdict answer;
        private final AtomicInteger asked = new AtomicInteger();

        FixedProbe(Verdict answer) {
            this.answer = answer;
        }

        @Override
        public boolean applies(RemotePath path) {
            return path instanceof WindowsRemotePath;
        }

        @Override
        public Verdict check(RemoteTarget target, RemotePath path, TransferLimits limits, ExecutionControl control) {
            asked.incrementAndGet();
            return answer;
        }
    }

    private TransferBed startWith(FixedProbe probe) throws IOException {
        bed = TransferBed.start(root, List.of(probe));
        return bed;
    }

    private UploadRequest upload(FileAccess access) {
        return new UploadRequest(TransferBed.TARGET, THROUGH_JUNCTION, CONTENT.length, new Sha256Digester().digest(CONTENT), OverwriteMode.FAIL_IF_EXISTS, access,
            new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    private DownloadRequest download() {
        return new DownloadRequest(TransferBed.TARGET, THROUGH_JUNCTION, new FileAccess.Direct(), new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    private PermissionRequest permissions() {
        return new PermissionRequest(TransferBed.TARGET, THROUGH_JUNCTION, new FileMode(0600), new PermissionSupport.Supported(), new FileAccess.Direct(),
            new PathPolicyBinding.NoRootPolicy(), TransferLimits.defaults());
    }

    @Test
    @DisplayName("S3-RW-04 a link that the SFTP server does not show is UNSAFE_PATH for an upload, a download and a permission change, and no session is leased")
    void linkedPathIsRefusedEverywhere() throws IOException {
        FixedProbe probe = new FixedProbe(new HiddenLinkProbe.Linked());
        TransferBed testBed = startWith(probe);

        UploadResult uploaded = testBed.transfer().upload(upload(new FileAccess.Direct()), TransferBed.source(CONTENT), testBed.control());
        DownloadResult downloaded = testBed.transfer().download(download(), new TransferBed.Collecting(), testBed.control());
        PermissionResult changed = testBed.transfer().applyPermissions(permissions(), testBed.control());

        assertThat(uploaded).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(downloaded).isEqualTo(new DownloadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None()));
        assertThat(changed).isEqualTo(new PermissionResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None()));
        assertThat(probe.asked.get()).isEqualTo(3);
        assertThat(testBed.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-RW-04 S3-EL-03 the elevated path (the administrator plan) is checked the same way, before the administrator probe")
    void administratorPathIsChecked() throws IOException {
        FixedProbe probe = new FixedProbe(new HiddenLinkProbe.Linked());
        TransferBed testBed = startWith(probe);
        ElevationPlan plan = new ElevationPlan.WindowsAdministratorCheck(new FixedRemoteCommand("admin-probe", "powershell.exe -NoLogo admin-probe"));

        UploadResult result = testBed.transfer().upload(upload(new FileAccess.Elevated(plan)), TransferBed.source(CONTENT), testBed.control());

        assertThat(result).isEqualTo(new UploadResult.Refused(TransferErrorCode.UNSAFE_PATH, new FileDiagnostic.None(), CleanupState.COMPLETE));
        assertThat(testBed.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-RW-04 a probe that cannot say (the command failed) refuses the path as invalid; one that did not run is NotDispatched / Failed with the reason")
    void unverifiedAndNotRun() throws IOException {
        TransferBed unverified = startWith(new FixedProbe(new HiddenLinkProbe.Unverified()));
        assertThat(unverified.transfer().upload(upload(new FileAccess.Direct()), TransferBed.source(CONTENT), unverified.control()))
            .isEqualTo(new UploadResult.Refused(TransferErrorCode.INVALID_REQUEST, new FileDiagnostic.None(), CleanupState.COMPLETE));
        unverified.close();

        TransferBed notRun = startWith(new FixedProbe(new HiddenLinkProbe.NotRun(TransferFailureCause.DEADLINE)));
        assertThat(notRun.transfer().upload(upload(new FileAccess.Direct()), TransferBed.source(CONTENT), notRun.control())).isEqualTo(new UploadResult.NotDispatched(TransferFailureCause.DEADLINE));
        assertThat(notRun.transfer().download(download(), new TransferBed.Collecting(), notRun.control())).isEqualTo(new DownloadResult.Failed(TransferFailureCause.DEADLINE));
        assertThat(notRun.transfer().applyPermissions(permissions(), notRun.control())).isEqualTo(new PermissionResult.NotDispatched(TransferFailureCause.DEADLINE));
        assertThat(notRun.sessions().leases()).isZero();
    }

    @Test
    @DisplayName("S3-RW-04 a path with no link goes on to the SFTP work (the server was asked); a POSIX path is not asked about at all")
    void clearAndPosixPaths() throws IOException {
        FixedProbe probe = new FixedProbe(new HiddenLinkProbe.Clear());
        TransferBed testBed = startWith(probe);

        // the Windows path does not exist on the POSIX-rooted test server; the answer of the SFTP work is not the subject, only that the work was begun
        testBed.transfer().upload(upload(new FileAccess.Direct()), TransferBed.source(CONTENT), testBed.control());
        int askedForWindows = probe.asked.get();
        assertThat(testBed.sessions().leases()).as("a clear path goes on to the SFTP work, which leases a session").isEqualTo(1);
        UploadResult posix = testBed.transfer().upload(testBed.upload("/plain.bin", CONTENT, OverwriteMode.FAIL_IF_EXISTS), TransferBed.source(CONTENT), testBed.control());

        assertThat(askedForWindows).isEqualTo(1);
        assertThat(testBed.sessions().leases()).as("the POSIX path too").isEqualTo(2);
        assertThat(probe.asked.get()).as("the POSIX path was not asked about").isEqualTo(1);
        assertThat(posix).isInstanceOf(UploadResult.Published.class);
    }
}
