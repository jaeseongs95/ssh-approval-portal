package io.github.jaeseongs95.portal.server.usecase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.audit.AuditAction;
import io.github.jaeseongs95.portal.app.file.OperationUploadAdmission;
import io.github.jaeseongs95.portal.app.file.StagedBegin;
import io.github.jaeseongs95.portal.app.file.StagedFileService;
import io.github.jaeseongs95.portal.app.file.StagedPlacement;
import io.github.jaeseongs95.portal.app.file.StagedPlacementRequest;
import io.github.jaeseongs95.portal.app.journal.OperationJournal;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.app.operation.OperationIntake;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.file.FileBinding;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.file.FileTargetBinding;
import io.github.jaeseongs95.portal.domain.id.ArtifactId;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.Digester;
import io.github.jaeseongs95.portal.domain.id.OperationId;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.operation.ConflictKey;
import io.github.jaeseongs95.portal.domain.operation.Deadline;
import io.github.jaeseongs95.portal.domain.operation.DownloadInput;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.NewOperation;
import io.github.jaeseongs95.portal.domain.operation.Operation;
import io.github.jaeseongs95.portal.domain.operation.OperationEvent;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OutcomeCertainty;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.Reconciliation;
import io.github.jaeseongs95.portal.domain.operation.RecordedResult;
import io.github.jaeseongs95.portal.domain.operation.RemoteState;
import io.github.jaeseongs95.portal.domain.operation.Settlement;
import io.github.jaeseongs95.portal.domain.operation.StartAuthority;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PathSyntax;
import io.github.jaeseongs95.portal.domain.text.Utf8Text;

/**
 * The file operations through the whole use case path with the real journal, artifact registry and payload stores: a copy of a staged file is admitted by
 * {@link OperationUploadAdmission} (the request entrance and the intake every request goes through), approved, dispatched to the upload runner, and settled from what
 * the SFTP boundary answers (stage 3 design 8.5: S3-SF-04 to S3-SF-06, S3-SF-09; defects D-0035 and D-0013). Only the SFTP and the SSH boundaries are plain test classes.
 */
@UseCaseTest
class FileOperationsTest {

    private static final StartAuthority OWNER = new StartAuthority.Owner();

    private final StagedFileService staged;
    private final OperationUploadAdmission admission;
    private final OperationIntake intake;
    private final OperationJournal journal;
    private final MaintenanceStore maintenance;
    private final ScriptedTransfer transfer;
    private final RecordingAudit audit;
    private final FixedTargets targets;
    private final UseCaseKit kit;
    private final Digester digester;

    FileOperationsTest(StagedFileService staged, OperationUploadAdmission admission, OperationIntake intake, OperationJournal journal, MaintenanceStore maintenance,
                       ScriptedTransfer transfer, RecordingAudit audit, FixedTargets targets, UseCaseKit kit, Digester digester) {
        this.staged = staged;
        this.admission = admission;
        this.intake = intake;
        this.journal = journal;
        this.maintenance = maintenance;
        this.transfer = transfer;
        this.audit = audit;
        this.targets = targets;
        this.kit = kit;
        this.digester = digester;
    }

    @BeforeEach
    void start() {
        transfer.reset();
        audit.failNothing();
        targets.reset();
    }

    /** Stages a file and copies it to a path on the test target; the operation waits for the owner, as every operation does. */
    private OperationId place(byte[] content, String remotePath) {
        OwnerId owner = new OwnerId("owner");
        StagedBegin begun = staged.begin(owner, kit.newKey().value(), new FileName("staged.bin"), content.length);
        ArtifactUuid uuid = ((StagedBegin.Begun) begun).uuid();
        staged.append(owner, uuid, 0, content, digester.digest(content));
        staged.complete(owner, uuid);
        StagedPlacement placed = staged.place(new StagedPlacementRequest(owner, uuid, StagedActionKind.COPY, kit.newKey().value(), targets.current(),
            targets.current().revision(), PathSyntax.POSIX.path(remotePath), OverwriteMode.REPLACE, Elevation.NONE));
        return ((StagedPlacement.Placed) placed).operation();
    }

    private static RecordedResult resultOf(Operation operation) {
        return ((Settlement.Settled) operation.settlement()).result();
    }

    private Operation approvedAndDone(OperationId id) throws Exception {
        intake.approve(id, OWNER);
        return kit.awaitTerminal(id);
    }

    @Test
    @DisplayName("S3-SF-01 S3-UC-01 a copy of a staged file is admitted as a pending upload, approved, dispatched, published once with the staged bytes, and completed; the audit lines are written")
    void anUploadIsAdmittedDispatchedPublishedAndCompleted() throws Exception {
        byte[] content = "the content of the file".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        OperationId id = place(content, "/srv/app/file.txt");
        assertThat(kit.find(id).state()).isEqualTo(OperationState.PENDING);
        assertThat(transfer.uploadsSent()).isZero();

        Operation done = approvedAndDone(id);

        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(resultOf(done)).isInstanceOf(RecordedResult.Executed.class);
        assertThat(transfer.uploadsSent()).isEqualTo(1);
        assertThat(transfer.uploaded()).hasSize(1);
        assertThat(transfer.uploaded().get(0)).isEqualTo(content);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(audit.actionsOf(id))
            .containsExactly(AuditAction.SUBMITTED, AuditAction.EXECUTION_QUEUED, AuditAction.APPROVED, AuditAction.COMPLETED));
    }

    @Test
    @DisplayName("S3-SF-01 the same copy request is the same operation: placing it again answers the operation that exists and admits nothing twice")
    void theSameCopyIsOneOperation() {
        OwnerId owner = new OwnerId("owner");
        byte[] content = "same copy".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        StagedBegin begun = staged.begin(owner, kit.newKey().value(), new FileName("staged.bin"), content.length);
        ArtifactUuid uuid = ((StagedBegin.Begun) begun).uuid();
        staged.append(owner, uuid, 0, content, digester.digest(content));
        staged.complete(owner, uuid);
        StagedPlacementRequest request = new StagedPlacementRequest(owner, uuid, StagedActionKind.COPY, kit.newKey().value(), targets.current(), targets.current().revision(),
            PathSyntax.POSIX.path("/srv/app/again.txt"), OverwriteMode.REPLACE, Elevation.NONE);

        StagedPlacement first = staged.place(request);
        StagedPlacement second = staged.place(request);

        assertThat(((StagedPlacement.Placed) second).operation()).isEqualTo(((StagedPlacement.Placed) first).operation());
        assertThat(audit.actionsOf(((StagedPlacement.Placed) first).operation())).containsExactly(AuditAction.SUBMITTED);
    }

    @Test
    @DisplayName("S3-SF-04 S3-SF-05 RC-D-0035 a failure after the replacement is never a completion: rolled back is FAILED, an original that cannot be confirmed back or a content that is not the approved one is UNKNOWN to reconcile, and no COMPLETED is ever written")
    void aFailureAfterTheReplacementIsNeverCompleted() throws Exception {
        transfer.onUpload(transfer.rollsBack());
        Operation rolledBack = approvedAndDone(place("rolled back".getBytes(java.nio.charset.StandardCharsets.UTF_8), "/srv/app/rolled.txt"));
        assertThat(rolledBack.state()).isEqualTo(OperationState.FAILED);
        assertNoCompletion(rolledBack.id());

        transfer.onUpload(transfer.losesTheOriginal());
        Operation lost = approvedAndDone(place("lost original".getBytes(java.nio.charset.StandardCharsets.UTF_8), "/srv/app/lost.txt"));
        assertThat(lost.state()).isEqualTo(OperationState.UNKNOWN);
        assertThat(((Settlement.Settled) lost.settlement()).reconciliation()).isEqualTo(Reconciliation.REQUIRED);
        assertNoCompletion(lost.id());

        transfer.onUpload(transfer.publishesAnotherDigest());
        Operation other = approvedAndDone(place("another digest".getBytes(java.nio.charset.StandardCharsets.UTF_8), "/srv/app/other.txt"));
        assertThat(other.state()).isEqualTo(OperationState.UNKNOWN);
        assertNoCompletion(other.id());

        assertThat(transfer.uploadsSent()).as("each upload was sent once, none again").isEqualTo(3);
    }

    private void assertNoCompletion(OperationId id) {
        assertThat(journal.events(id).stream().map(OperationEvent::state).toList()).doesNotContain(OperationState.COMPLETED);
    }

    @Test
    @DisplayName("S3-SF-06 a small file (850 bytes) is read, stored and verified: the download completes")
    void aSmallDownloadCompletes() throws Exception {
        byte[] content = new byte[850];
        for (int i = 0; i < content.length; i++) {
            content[i] = (byte) (i % 251);
        }
        transfer.onDownload(transfer.fetches(content));

        Operation done = approvedAndDone(submitDownload("/var/log/small.log"));

        assertThat(done.state()).isEqualTo(OperationState.COMPLETED);
        assertThat(transfer.downloadsSent()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SF-09 RC-D-0013 a connection lost while a file is read is FAILED with nothing to reconcile, not UNKNOWN: a download changes nothing on the target; it is not sent again")
    void aDownloadThatLosesItsConnectionIsFailedNotUnknown() throws Exception {
        transfer.onDownload(transfer.disconnects());

        Operation done = approvedAndDone(submitDownload("/var/log/lost.log"));

        assertThat(done.state()).isEqualTo(OperationState.FAILED);
        Settlement.Settled settled = (Settlement.Settled) done.settlement();
        assertThat(settled.reconciliation()).isEqualTo(Reconciliation.NOT_REQUIRED);
        assertThat(settled.certainty()).isEqualTo(OutcomeCertainty.NOT_DISPATCHED);
        RecordedResult.Executed executed = (RecordedResult.Executed) settled.result();
        assertThat(executed.outcome().remoteState()).isEqualTo(RemoteState.NOT_DISPATCHED);
        assertThat(transfer.downloadsSent()).isEqualTo(1);
    }

    @Test
    @DisplayName("S3-SS-03 RC-A-469 the admission is the intake of every request: in a maintenance window it is MAINTENANCE_ACTIVE and writes nothing, after the window the same upload is accepted once, and only an upload is admitted")
    void theAdmissionIsTheIntakeOfEveryRequest() {
        UploadInput input = new UploadInput(new ArtifactId("b".repeat(48)), PathSyntax.POSIX.path("/srv/app/window.txt"), new FileName("window.txt"), 10, new Digest("d".repeat(64)),
            OverwriteMode.REPLACE, Elevation.NONE, new FileBinding.Bound(new FileTargetBinding(FixedTargets.ID, targets.current().revision())), UploadProtocol.UNSPECIFIED);
        NewOperation upload = NewOperation.of(digester, kit.newKey(), new OwnerId("owner"), FixedTargets.ID, targets.current().revision(), FixedTargets.WRITE_PROFILE, input,
            new ConflictKey.None(), new Deadline.None());
        OwnerHash window = new OwnerHash((UUID.randomUUID().toString() + UUID.randomUUID()).replace("-", ""));
        maintenance.reserve(window);
        try {
            assertThatThrownBy(() -> admission.admit(upload)).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(RequestErrorCode.MAINTENANCE_ACTIVE));
            assertThat(journal.findByRequestKey(upload.requestKey())).isEmpty();
        } finally {
            maintenance.release(window);
        }

        OperationId id = admission.admit(upload);

        assertThat(admission.admit(upload)).as("the same key and contract is the same operation").isEqualTo(id);
        assertThat(kit.find(id).state()).isEqualTo(OperationState.PENDING);
        assertThat(audit.actionsOf(id)).containsExactly(AuditAction.SUBMITTED);
        assertThatThrownBy(() -> admission.admit(kit.command("echo not-an-upload"))).isInstanceOf(IllegalArgumentException.class);
        assertThat(transfer.uploadsSent()).isZero();
        intake.deny(id);
    }

    private OperationId submitDownload(String remotePath) {
        DownloadInput input = new DownloadInput(PathSyntax.POSIX.path(remotePath), Elevation.NONE,
            new FileBinding.Bound(new FileTargetBinding(FixedTargets.ID, targets.current().revision())), new Utf8Text("caller"), new Utf8Text("display"));
        NewOperation spec = NewOperation.of(digester, kit.newKey(), new OwnerId("owner"), FixedTargets.ID, targets.current().revision(), FixedTargets.READ_PROFILE, input,
            new ConflictKey.None(), new Deadline.None());
        return intake.submit(spec).id();
    }
}
