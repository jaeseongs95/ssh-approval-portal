package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ChunkDigest;
import io.github.jaeseongs95.portal.app.artifact.ContentDigest;
import io.github.jaeseongs95.portal.app.file.DownloadExecution;
import io.github.jaeseongs95.portal.app.file.DownloadJob;
import io.github.jaeseongs95.portal.app.file.DownloadService;
import io.github.jaeseongs95.portal.app.file.FilePermission;
import io.github.jaeseongs95.portal.app.file.UploadJob;
import io.github.jaeseongs95.portal.app.file.UploadService;
import io.github.jaeseongs95.portal.app.remote.CancelSource;
import io.github.jaeseongs95.portal.app.remote.ExecutionControl;
import io.github.jaeseongs95.portal.app.remote.FileAccess;
import io.github.jaeseongs95.portal.app.remote.FileDiagnostic;
import io.github.jaeseongs95.portal.app.remote.FileMode;
import io.github.jaeseongs95.portal.app.remote.PermissionResult;
import io.github.jaeseongs95.portal.app.remote.RestoreEvidence;
import io.github.jaeseongs95.portal.app.remote.TransferFailureCause;
import io.github.jaeseongs95.portal.app.remote.UnconfirmedCause;
import io.github.jaeseongs95.portal.app.remote.UploadResult;
import io.github.jaeseongs95.portal.domain.error.DispatchFailure;
import io.github.jaeseongs95.portal.domain.error.DispatchReason;
import io.github.jaeseongs95.portal.domain.error.DispatchRefusedException;
import io.github.jaeseongs95.portal.domain.error.DispatchStage;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionFailure;
import io.github.jaeseongs95.portal.domain.error.ExecutionStage;
import io.github.jaeseongs95.portal.domain.error.RemoteOutcome;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.error.TransferErrorCode;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CleanupState;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.ExecutionOutcome;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.path.WindowsRemotePath;
import io.github.jaeseongs95.portal.domain.target.AccessMode;
import io.github.jaeseongs95.portal.domain.target.ResolvedTarget;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The upload and the download use cases on the real artifact store (H2 and real files) with the SSH boundary faked: cases of defects D-0035 (no completed operation without
 * the evidence), D-0013 and decision D3-17 (a read-only download never leaves the target in doubt), D-0012 (the reservation refusal and its numbers), and design 4.6 (permission
 * bits are never set on a target that cannot set them, and never ignored silently).
 */
@AssemblyTest
class TransferServicesTest {

    private static final Sha256Digester DIGEST = new Sha256Digester();
    private static final ExecutionControl CONTROL = new ExecutionControl(new CancelSource(), () -> { });

    private final UploadService uploads;
    private final DownloadService downloads;
    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final FakeRemote remote;
    private final FakeTargets targets;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    TransferServicesTest(UploadService uploads, DownloadService downloads, ArtifactRegistry registry, ArtifactPayloadStore payloads, FakeRemote remote, FakeTargets targets,
                         JdbcTemplate jdbc, Clock clock) {
        this.uploads = uploads;
        this.downloads = downloads;
        this.registry = registry;
        this.payloads = payloads;
        this.remote = remote;
        this.targets = targets;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @BeforeEach
    void clean() {
        remote.reset();
        targets.reset();
        jdbc.update("DELETE FROM staged_action");
        jdbc.update("DELETE FROM artifact_chunk");
        jdbc.update("DELETE FROM artifact");
    }

    // ---- upload ----

    @Test
    @DisplayName("S3-SF-01 / D-0035 / G4: a published upload completes only with the FilePublished evidence of the approved digest; the target got exactly the stored bytes, once")
    void aPublishedUploadCompletesWithItsEvidence() {
        byte[] bytes = bytes(1500, 7);
        UploadJob job = uploadJob(readyUpload(bytes), bytes, new FilePermission.PlatformDefault(), Elevation.NONE, targets.linux());

        ExecutionOutcome outcome = uploads.upload(job, CONTROL);

        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(outcome.evidence()).isInstanceOfSatisfying(CompletionEvidence.FilePublished.class, evidence -> assertThat(evidence.sha256()).isEqualTo(DIGEST.digest(bytes)));
        assertThat(remote.uploads).hasSize(1);
        assertThat(remote.uploaded).isEqualTo(bytes);
        assertThat(remote.uploads.get(0).target().access()).isEqualTo(AccessMode.READ_WRITE);
        assertThat(remote.uploads.get(0).target().profile()).isEqualTo(FakeTargets.LINUX_WRITE);
        assertThat(remote.permissions).as("a request without a mode sets none").isEmpty();
    }

    @Test
    @DisplayName("D-0035: the answers of an upload that is not a confirmed publication are never a completion: the digest that does not match the approved one, a failure after the replacement, a refusal, a result that is not known")
    void onlyAConfirmedPublicationCompletes() {
        byte[] bytes = bytes(600, 3);
        Digest other = DIGEST.digest(bytes(5, 9));
        Map<String, Case> cases = new LinkedHashMap<>();
        cases.put("published with another digest", new Case(new UploadResult.Published(other, clock.instant(), io.github.jaeseongs95.portal.app.remote.ReplaceMethod.POSIX_RENAME),
            OperationState.UNKNOWN));
        cases.put("rolled back, original confirmed", new Case(new UploadResult.RolledBack(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3),
            new RestoreEvidence(clock.instant())), OperationState.FAILED));
        cases.put("refused, temporary file removed", new Case(new UploadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3),
            CleanupState.COMPLETE), OperationState.FAILED));
        cases.put("refused, temporary file may remain", new Case(new UploadResult.Refused(TransferErrorCode.STAGING_UNAVAILABLE, new FileDiagnostic.NoSpace(),
            CleanupState.INCOMPLETE), OperationState.UNKNOWN));
        cases.put("transport lost after the first write", new Case(new UploadResult.Unconfirmed(new UnconfirmedCause.TransportLost(), CleanupState.INCOMPLETE),
            OperationState.UNKNOWN));
        cases.put("replacement confirmed, durability not (D3-15)", new Case(new UploadResult.Unconfirmed(new UnconfirmedCause.DurabilityUnconfirmed(), CleanupState.COMPLETE),
            OperationState.UNKNOWN));
        cases.put("restore not confirmed", new Case(new UploadResult.Unconfirmed(new UnconfirmedCause.RestoreUnconfirmed(".ssh-approval-bak-1"), CleanupState.INCOMPLETE),
            OperationState.UNKNOWN));
        cases.put("not dispatched, connection failed", new Case(new UploadResult.NotDispatched(TransferFailureCause.CONNECT_FAILED), OperationState.FAILED));

        for (Map.Entry<String, Case> entry : cases.entrySet()) {
            remote.reset();
            remote.uploadAnswer = entry.getValue().answer();
            ExecutionOutcome outcome = uploads.upload(uploadJob(readyUpload(bytes), bytes, new FilePermission.PlatformDefault(), Elevation.NONE, targets.linux()), CONTROL);

            assertThat(outcome.verdict()).as(entry.getKey()).isEqualTo(entry.getValue().state());
            assertThat(outcome.evidence()).as(entry.getKey() + ": no evidence").isInstanceOf(CompletionEvidence.NoEvidence.class);
            assertThat(outcome.reconciliation() == Reconciliation.REQUIRED).as(entry.getKey() + ": reconcile only when unknown")
                .isEqualTo(entry.getValue().state() == OperationState.UNKNOWN);
            assertThat(remote.uploads).as(entry.getKey() + ": sent once").hasSize(1);
            jdbc.update("DELETE FROM artifact_chunk");
            jdbc.update("DELETE FROM artifact");
        }
    }

    @Test
    @DisplayName("S3-SF-11 / design 4.6: an explicit permission mode on a target that cannot set it is refused with TARGET_CAPABILITY_UNSUPPORTED before anything is sent; the default publication skips the step")
    void permissionBitsAreRefusedOnWindowsAndSkippedByDefault() {
        byte[] bytes = bytes(100, 1);
        UploadJob explicit = windowsJob(bytes, new FilePermission.Explicit(new FileMode(0640)), Elevation.NONE);

        assertThatThrownBy(() -> uploads.upload(explicit, CONTROL)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED));
        assertThat(remote.uploads).as("nothing was sent").isEmpty();
        assertThat(remote.permissions).isEmpty();

        ExecutionOutcome outcome = uploads.upload(windowsJob(bytes, new FilePermission.PlatformDefault(), Elevation.NONE), CONTROL);

        assertThat(outcome.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(remote.permissions).as("the default publication of a Windows target sets no bits").isEmpty();
    }

    @Test
    @DisplayName("S3-SF-12: an explicit mode on a Linux target is applied after the publication, and only a confirmed mode completes; a refused or unconfirmed one leaves the result unknown")
    void anExplicitModeIsAppliedAfterThePublication() {
        byte[] bytes = bytes(100, 2);

        ExecutionOutcome applied = uploads.upload(uploadJob(readyUpload(bytes), bytes, new FilePermission.Explicit(new FileMode(0640)), Elevation.NONE, targets.linux()), CONTROL);
        assertThat(applied.verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(remote.permissions).hasSize(1);
        assertThat(remote.permissions.get(0).mode()).isEqualTo(new FileMode(0640));

        jdbc.update("DELETE FROM artifact_chunk");
        jdbc.update("DELETE FROM artifact");
        remote.permissionAnswer = new PermissionResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3));
        ExecutionOutcome refused = uploads.upload(uploadJob(readyUpload(bytes), bytes, new FilePermission.Explicit(new FileMode(0640)), Elevation.NONE, targets.linux()),
            CONTROL);
        assertThat(refused.verdict()).as("the file is published and its bits are not what was asked").isEqualTo(OperationState.UNKNOWN);
    }

    @Test
    @DisplayName("G4: an artifact that is no longer what was approved is refused as a file guard before any byte is sent: another digest, a file that is not ready, and a missing one")
    void anArtifactThatChangedIsRefusedBeforeDispatch() {
        byte[] bytes = bytes(100, 4);
        ArtifactId id = readyUpload(bytes);
        UploadJob changed = uploadJob(id, bytes(100, 5), new FilePermission.PlatformDefault(), Elevation.NONE, targets.linux());
        UploadJob missing = uploadJob(new ArtifactId("1".repeat(48)), bytes, new FilePermission.PlatformDefault(), Elevation.NONE, targets.linux());
        ArtifactId staging = reserveUpload(bytes);
        UploadJob notReady = uploadJob(staging, bytes, new FilePermission.PlatformDefault(), Elevation.NONE, targets.linux());

        for (UploadJob job : new UploadJob[] {changed, missing, notReady}) {
            assertThatThrownBy(() -> uploads.upload(job, CONTROL)).isInstanceOfSatisfying(DispatchRefusedException.class,
                e -> assertThat(e.failure()).isEqualTo(DispatchFailure.refused(DispatchReason.UNKNOWN, DispatchStage.FILE_GUARD)));
        }
        assertThat(remote.uploads).isEmpty();
    }

    @Test
    @DisplayName("G4: an elevated upload needs an elevation plan: a Linux target gets an elevated access, a Windows target is refused with TARGET_CAPABILITY_UNSUPPORTED")
    void elevationNeedsAPlan() {
        byte[] bytes = bytes(100, 6);

        uploads.upload(uploadJob(ready(uploadSpec(bytes, Elevation.SUDO), bytes), bytes, new FilePermission.PlatformDefault(), Elevation.SUDO, targets.linux()), CONTROL);
        assertThat(remote.uploads.get(0).access()).isInstanceOf(FileAccess.Elevated.class);

        UploadJob windows = windowsJob(bytes, new FilePermission.PlatformDefault(), Elevation.SUDO);
        assertThatThrownBy(() -> uploads.upload(windows, CONTROL)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_CAPABILITY_UNSUPPORTED));
    }

    // ---- download ----

    @Test
    @DisplayName("S3-SF-06 / D-0013: an 850 byte download is stored, verified and ready with its real size and digest; the outcome completes with FileRead(verified), at the read profile")
    void aSmallDownloadIsStoredAndVerified() {
        remote.served = bytes(850, 9);

        DownloadExecution execution = downloads.download(downloadJob(), CONTROL);

        assertThat(execution).isInstanceOf(DownloadExecution.Stored.class);
        DownloadExecution.Stored stored = (DownloadExecution.Stored) execution;
        assertThat(stored.outcome().verdict()).isEqualTo(OperationState.COMPLETED);
        assertThat(stored.outcome().evidence()).isEqualTo(new CompletionEvidence.FileRead(true));
        ArtifactRecord artifact = stored.artifact();
        assertThat(artifact.state()).isEqualTo(ArtifactState.READY);
        assertThat(artifact.spec().sizeBytes()).isEqualTo(850);
        assertThat(artifact.content()).isEqualTo(new ContentDigest.Sealed(DIGEST.digest(remote.served)));
        assertThat(registry.budget().chargedBytes()).as("the charge fell from the reservation to the real size").isEqualTo(850);
        assertThat(remote.downloads.get(0).target().access()).isEqualTo(AccessMode.READ_ONLY);
        assertThat(payloads.length(artifact.id())).isEqualTo(850);
    }

    @Test
    @DisplayName("S3-SF-08 / S3-SF-09 / D3-17: every failure of a download is NOT_DISPATCHED, needs no reconciliation and is FAILED, and gives the reserved bytes back; a refusal, a too large file and a lost connection alike")
    void aFailedDownloadLeavesNothingToReconcile() {
        Map<String, io.github.jaeseongs95.portal.app.remote.DownloadResult> answers = new LinkedHashMap<>();
        answers.put("permission denied", new io.github.jaeseongs95.portal.app.remote.DownloadResult.Refused(TransferErrorCode.PERMISSION_DENIED, new FileDiagnostic.SftpStatus(3)));
        answers.put("file not found", new io.github.jaeseongs95.portal.app.remote.DownloadResult.Refused(TransferErrorCode.FILE_NOT_FOUND, new FileDiagnostic.None()));
        answers.put("too large", new io.github.jaeseongs95.portal.app.remote.DownloadResult.TooLarge(20_000, 10_000));
        answers.put("connection lost during the read", new io.github.jaeseongs95.portal.app.remote.DownloadResult.Failed(TransferFailureCause.TRANSPORT_LOST));

        for (Map.Entry<String, io.github.jaeseongs95.portal.app.remote.DownloadResult> entry : answers.entrySet()) {
            remote.downloadAnswer = entry.getValue();

            DownloadExecution execution = downloads.download(downloadJob(), CONTROL);

            assertThat(execution).as(entry.getKey()).isInstanceOf(DownloadExecution.NotStored.class);
            ExecutionOutcome outcome = execution.outcome();
            assertThat(outcome.verdict()).as(entry.getKey()).isEqualTo(OperationState.FAILED);
            assertThat(outcome.remoteState()).as(entry.getKey()).isEqualTo(RemoteState.NOT_DISPATCHED);
            assertThat(outcome.reconciliation()).as(entry.getKey()).isEqualTo(Reconciliation.NOT_REQUIRED);
            assertThat(registry.holding()).as(entry.getKey() + ": no artifact is left").isEmpty();
            assertThat(registry.budget().chargedBytes()).as(entry.getKey() + ": no charge is left").isZero();
        }
    }

    @Test
    @DisplayName("S3-AR-02 / D-0012: a download whose reservation the budget refuses is FAILED with ARTIFACT_QUOTA at the operation stage, NOT_STARTED, the numbers in the text, and the target was never asked")
    void aRefusedReservationIsAClassifiedFailureAndTheTargetIsNotAsked() {
        for (int i = 0; i < 10; i++) {
            reserveUpload(bytes(9_500, i));
        }

        DownloadExecution execution = downloads.download(downloadJob(), CONTROL);

        ExecutionOutcome outcome = execution.outcome();
        assertThat(execution).isInstanceOf(DownloadExecution.NotStored.class);
        assertThat(outcome.failure()).isEqualTo(new ExecutionFailure.Classified(ExecutionStage.OPERATION, ExecutionErrorCode.ARTIFACT_QUOTA, RemoteOutcome.NOT_STARTED));
        assertThat(outcome.texts().get(0)).contains("requestedBytes=10000", "liveBytes=95000", "holdingBytes=0", "budgetBytes=100000");
        assertThat(outcome.verdict()).isEqualTo(OperationState.FAILED);
        assertThat(remote.downloads).as("the target was not asked").isEmpty();
    }

    @Test
    @DisplayName("RC-A-182 / RC-A-183: bytes whose digest is not the one the adapter confirmed are not delivered: the artifact, its bytes and its charge are gone")
    void bytesThatDoNotMatchWhatTheAdapterConfirmedAreNotDelivered() {
        remote.served = bytes(300, 2);
        remote.lieAboutTheDigest = true;

        DownloadExecution execution = downloads.download(downloadJob(), CONTROL);

        assertThat(execution).isInstanceOf(DownloadExecution.NotStored.class);
        assertThat(execution.outcome().texts().get(0)).startsWith("FILE_CHANGED");
        assertThat(execution.outcome().verdict()).isEqualTo(OperationState.FAILED);
        assertThat(registry.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    @Test
    @DisplayName("D-0013: an exception of the adapter (the dispatch guard) discards the artifact and goes on to the caller; nothing stays reserved")
    void anExceptionOfTheAdapterDiscardsTheArtifact() {
        remote.downloadFailure = new DispatchRefusedException(DispatchFailure.refused(DispatchReason.TARGET_CHANGED, DispatchStage.TARGET_GUARD));

        assertThatThrownBy(() -> downloads.download(downloadJob(), CONTROL)).isInstanceOf(DispatchRefusedException.class);

        assertThat(registry.holding()).isEmpty();
        assertThat(registry.budget().chargedBytes()).isZero();
    }

    // ---- helpers ----

    private record Case(UploadResult answer, OperationState state) {
    }

    private byte[] bytes(int length, int fill) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) fill);
        return bytes;
    }

    private ArtifactSpec uploadSpec(byte[] bytes) {
        return uploadSpec(bytes, Elevation.NONE);
    }

    private ArtifactSpec uploadSpec(byte[] bytes, Elevation elevation) {
        ResolvedTarget linux = targets.linux();
        return new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("a.bin"), bytes.length, new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Assigned(new PosixRemotePath("/srv/a.bin"), FakeTargets.LINUX_ID, linux.revision(), BindingKind.BOUND), OverwriteMode.REPLACE, elevation,
            UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE, java.time.Duration.ofMinutes(10));
    }

    /** A reserved upload that stays {@code STAGING}. */
    private ArtifactId reserveUpload(byte[] bytes) {
        ArtifactReservation reservation = registry.reserve(uploadSpec(bytes), clock.instant());
        assertThat(reservation).isInstanceOf(ArtifactReservation.Reserved.class);
        return ((ArtifactReservation.Reserved) reservation).id();
    }

    private ArtifactId readyUpload(byte[] bytes) {
        return ready(uploadSpec(bytes), bytes);
    }

    private ArtifactId ready(ArtifactSpec spec, byte[] bytes) {
        ArtifactReservation reservation = registry.reserve(spec, clock.instant());
        ArtifactId id = ((ArtifactReservation.Reserved) reservation).id();
        payloads.append(id, 0, bytes);
        registry.append(id, 0, new ChunkDigest(bytes.length, DIGEST.digest(bytes)));
        registry.markReady(id, DIGEST.digest(bytes));
        return id;
    }

    private UploadInput uploadInput(ArtifactId id, byte[] bytes, Elevation elevation, io.github.jaeseongs95.portal.domain.id.TargetId target, ResolvedTarget resolved) {
        return new UploadInput(id, new PosixRemotePath("/srv/a.bin"), new FileName("a.bin"), bytes.length, DIGEST.digest(bytes), OverwriteMode.REPLACE, elevation,
            new FileBinding.Bound(new FileTargetBinding(target, resolved.revision())), UploadProtocol.MCP_JSON_V1);
    }

    private UploadJob uploadJob(ArtifactId id, byte[] bytes, FilePermission permission, Elevation elevation, ResolvedTarget target) {
        return new UploadJob(target, target.revision(), uploadInput(id, bytes, elevation, target.target().id(), target), permission);
    }

    /** An upload to the Windows target; its artifact is bound to that target and a Windows path. */
    private UploadJob windowsJob(byte[] bytes, FilePermission permission, Elevation elevation) {
        ResolvedTarget windows = targets.windows();
        ArtifactSpec spec = new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("a.bin"), bytes.length, new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Assigned(new WindowsRemotePath("C:/data/a.bin"), FakeTargets.WINDOWS_ID, windows.revision(), BindingKind.BOUND), OverwriteMode.REPLACE,
            elevation, UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE, java.time.Duration.ofMinutes(10));
        ArtifactId id = ready(spec, bytes);
        UploadInput input = new UploadInput(id, new WindowsRemotePath("C:/data/a.bin"), new FileName("a.bin"), bytes.length, DIGEST.digest(bytes), OverwriteMode.REPLACE,
            elevation, new FileBinding.Bound(new FileTargetBinding(FakeTargets.WINDOWS_ID, windows.revision())), UploadProtocol.MCP_JSON_V1);
        return new UploadJob(windows, windows.revision(), input, permission);
    }

    private DownloadJob downloadJob() {
        ResolvedTarget linux = targets.linux();
        return new DownloadJob(linux, linux.revision(), new DownloadInput(new PosixRemotePath("/var/log/result.bin"), Elevation.NONE,
            new FileBinding.Bound(new FileTargetBinding(FakeTargets.LINUX_ID, linux.revision())), new Utf8Text("caller"), new Utf8Text("display")));
    }
}
