package io.github.jaeseongs95.portal.server.assembly;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.time.Duration;
import java.util.Arrays;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import io.github.jaeseongs95.portal.app.artifact.ArtifactDestination;
import io.github.jaeseongs95.portal.app.artifact.ArtifactDirection;
import io.github.jaeseongs95.portal.app.artifact.ArtifactOrigin;
import io.github.jaeseongs95.portal.app.artifact.ArtifactPayloadStore;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRecord;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRefusal;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRegistry;
import io.github.jaeseongs95.portal.app.artifact.ArtifactReservation;
import io.github.jaeseongs95.portal.app.artifact.ArtifactRetention;
import io.github.jaeseongs95.portal.app.artifact.ArtifactSpec;
import io.github.jaeseongs95.portal.app.artifact.ArtifactState;
import io.github.jaeseongs95.portal.app.artifact.BindingKind;
import io.github.jaeseongs95.portal.app.artifact.ConsumeReason;
import io.github.jaeseongs95.portal.app.artifact.ConsumeState;
import io.github.jaeseongs95.portal.app.artifact.StagedAction;
import io.github.jaeseongs95.portal.app.artifact.StagedActionKind;
import io.github.jaeseongs95.portal.app.artifact.StagedActionState;
import io.github.jaeseongs95.portal.app.file.StagedBegin;
import io.github.jaeseongs95.portal.app.file.StagedFileService;
import io.github.jaeseongs95.portal.app.file.StagedPlacement;
import io.github.jaeseongs95.portal.app.file.StagedPlacementRequest;
import io.github.jaeseongs95.portal.app.maintenance.MaintenanceStore;
import io.github.jaeseongs95.portal.app.maintenance.OwnerHash;
import io.github.jaeseongs95.portal.domain.error.ArtifactErrorCode;
import io.github.jaeseongs95.portal.domain.error.ErrorCode;
import io.github.jaeseongs95.portal.domain.error.ExecutionErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestErrorCode;
import io.github.jaeseongs95.portal.domain.error.RequestRefusedException;
import io.github.jaeseongs95.portal.domain.file.FileName;
import io.github.jaeseongs95.portal.domain.id.ArtifactUuid;
import io.github.jaeseongs95.portal.domain.id.Digest;
import io.github.jaeseongs95.portal.domain.id.OwnerId;
import io.github.jaeseongs95.portal.domain.id.Sha256Digester;
import io.github.jaeseongs95.portal.domain.operation.CompletionEvidence;
import io.github.jaeseongs95.portal.domain.operation.Elevation;
import io.github.jaeseongs95.portal.domain.operation.OperationState;
import io.github.jaeseongs95.portal.domain.operation.OverwriteMode;
import io.github.jaeseongs95.portal.domain.operation.UploadInput;
import io.github.jaeseongs95.portal.domain.operation.UploadProtocol;
import io.github.jaeseongs95.portal.domain.path.PosixRemotePath;
import io.github.jaeseongs95.portal.domain.target.TargetRevision;

/**
 * The staged files of the opaque file service (design 0.3 item 5, cases RC-B-091, RC-B-129 to RC-B-138, RC-B-371, RC-A-776) on the real artifact store: begin, append,
 * complete, remove, and copy and move that admit an upload of a copy. {@code remove} uses no SSH at all (the fake remote is never called in this class).
 */
@AssemblyTest
class StagedFileServiceTest {

    private static final Sha256Digester DIGEST = new Sha256Digester();
    private static final OwnerId OWNER = new OwnerId("verified-owner");

    private final StagedFileService staged;
    private final ArtifactRegistry registry;
    private final ArtifactPayloadStore payloads;
    private final MaintenanceStore maintenance;
    private final FakeAdmission admission;
    private final FakeRemote remote;
    private final FakeTargets targets;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    StagedFileServiceTest(StagedFileService staged, ArtifactRegistry registry, ArtifactPayloadStore payloads, MaintenanceStore maintenance, FakeAdmission admission,
                          FakeRemote remote, FakeTargets targets, JdbcTemplate jdbc, Clock clock) {
        this.staged = staged;
        this.registry = registry;
        this.payloads = payloads;
        this.maintenance = maintenance;
        this.admission = admission;
        this.remote = remote;
        this.targets = targets;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @BeforeEach
    void clean() {
        remote.reset();
        targets.reset();
        admission.reset();
        jdbc.update("DELETE FROM staged_action");
        jdbc.update("DELETE FROM artifact_chunk");
        jdbc.update("DELETE FROM artifact");
        jdbc.update("DELETE FROM maintenance_release");
        jdbc.update("DELETE FROM maintenance_reservation");
    }

    @Test
    @DisplayName("RC-B-091 / RC-B-105: a begin repeated with the same owner and key answers the same UUID, the same key with another size is OPERATION_KEY_CONFLICT, and a staged file is complete after its chunks and its digest")
    void aBeginIsRepeatableAndAFileCompletes() {
        ArtifactUuid uuid = stage("begin-key-0000000001", bytes(2000, 5));

        StagedBegin again = staged.begin(OWNER, "begin-key-0000000001", new FileName("f.bin"), 2000);
        assertThat(again).isEqualTo(new StagedBegin.Begun(uuid));
        assertThatThrownBy(() -> staged.begin(OWNER, "begin-key-0000000001", new FileName("f.bin"), 2001)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.OPERATION_KEY_CONFLICT));

        ArtifactRecord record = staged.stat(OWNER, uuid).artifact();
        assertThat(record.state()).isEqualTo(ArtifactState.READY);
        assertThat(record.receivedBytes()).isEqualTo(2000);
        assertThat(staged.complete(OWNER, uuid)).as("complete is repeatable").isEqualTo(record);
    }

    @Test
    @DisplayName("S3-AR-02 / RC-A-180: a begin that the budget or the file limit refuses answers the refusal with its numbers and stores nothing")
    void aRefusedBeginAnswersTheNumbers() {
        StagedBegin refused = staged.begin(OWNER, "begin-key-0000000002", new FileName("big.bin"), 20_000);

        assertThat(refused).isInstanceOfSatisfying(StagedBegin.Refused.class, r -> {
            assertThat(r.refusal().code()).isEqualTo(ArtifactErrorCode.FILE_TOO_LARGE);
            assertThat(r.refusal().detail()).isEqualTo(new ArtifactRefusal.Detail.SizeLimit(20_000, 10_000));
        });
        assertThat(registry.holding()).isEmpty();
    }

    @Test
    @DisplayName("RC-B-137: a wrong chunk digest changes nothing, another owner's UUID is not found, and removing twice answers the same tombstone")
    void aWrongChunkAndAnotherOwnerChangeNothing() {
        ArtifactUuid uuid = begin("chunk-key-0000000001", 10);
        byte[] bytes = bytes(10, 1);

        assertThatThrownBy(() -> staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes(10, 2)))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.CHUNK_HASH_MISMATCH));
        assertThat(staged.stat(OWNER, uuid).artifact().receivedBytes()).isZero();
        assertThatThrownBy(() -> staged.stat(new OwnerId("other-owner"), uuid)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_NOT_FOUND));
        assertThatThrownBy(() -> staged.append(OWNER, uuid, 1, bytes, DIGEST.digest(bytes))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_CHUNK_CONFLICT));

        staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes));
        staged.complete(OWNER, uuid);
        ArtifactRecord removed = staged.remove(OWNER, uuid);
        assertThat(removed.consumption()).isEqualTo(new ConsumeState.ConsumedBecause(ConsumeReason.REMOVED));
        assertThat(staged.remove(OWNER, uuid)).isEqualTo(removed);
        assertThat(payloads.stored()).as("the staged bytes are deleted, with no SSH").doesNotContain(removed.id());
        assertThat(remote.uploads).isEmpty();
    }

    @Test
    @DisplayName("RC-B-371: after its time an upload that is still staging refuses a chunk and a completion with ARTIFACT_EXPIRED, and its received bytes do not change")
    void anExpiredUploadRefusesChunks() {
        ArtifactUuid uuid = new io.github.jaeseongs95.portal.domain.id.ArtifactUuidGenerator(new java.security.SecureRandom()).next();
        ArtifactSpec spec = new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("f.bin"), 10, new ArtifactOrigin.Staged(uuid, OWNER, "expire-key-0000000001"),
            new ArtifactDestination.Unassigned(), OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.MCP_JSON_V1, ArtifactRetention.RELEASABLE, Duration.ofNanos(1_000));
        assertThat(registry.reserve(spec, clock.instant())).isInstanceOf(ArtifactReservation.Reserved.class);
        byte[] bytes = bytes(10, 1);

        assertThatThrownBy(() -> staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_EXPIRED));
        assertThatThrownBy(() -> staged.complete(OWNER, uuid)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_EXPIRED));
        assertThat(staged.stat(OWNER, uuid).artifact().receivedBytes()).isZero();
    }

    @Test
    @DisplayName("RC-B-138: an operation key with a line break at its end is refused before any admission, for copy and for move")
    void aKeyWithALineBreakIsRefusedBeforeAdmission() {
        ArtifactUuid uuid = stage("break-key-0000000001", bytes(100, 3));

        for (StagedActionKind kind : StagedActionKind.values()) {
            for (String suffix : new String[] {"\r", "\n", "\r\n"}) {
                assertThatThrownBy(() -> staged.place(request(uuid, kind, "valid-operation-key" + suffix, "/srv/a.bin"))).isInstanceOfSatisfying(RequestRefusedException.class,
                    e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.INVALID_OPERATION_KEY));
            }
        }
        assertThat(admission.admitted).isEmpty();
    }

    @Test
    @DisplayName("RC-B-129: a copy admits one upload of a bound copy and keeps the staged file; the same key and content answers the same operation without a second admission, other content is OPERATION_KEY_CONFLICT, another revision is TARGET_REVISION_CONFLICT")
    void aCopyAdmitsOneUploadOfACopyAndIsRepeatable() {
        byte[] bytes = bytes(700, 4);
        ArtifactUuid uuid = stage("copy-key-00000000001", bytes);

        StagedPlacement first = staged.place(request(uuid, StagedActionKind.COPY, "copy-operation-key-1", "/srv/a.bin"));
        StagedPlacement second = staged.place(request(uuid, StagedActionKind.COPY, "copy-operation-key-1", "/srv/a.bin"));

        assertThat(first).isInstanceOf(StagedPlacement.Placed.class);
        assertThat(second).isEqualTo(first);
        assertThat(admission.admitted).hasSize(1);
        UploadInput input = (UploadInput) admission.admitted.get(0).input();
        assertThat(input.sha256()).isEqualTo(DIGEST.digest(bytes));
        assertThat(input.artifactId()).isNotEqualTo(staged.stat(OWNER, uuid).artifact().id());
        ArtifactRecord copy = registry.find(input.artifactId()).orElseThrow();
        assertThat(copy.state()).as("a ready copy, bound to the target and pinned by its operation").isEqualTo(ArtifactState.READY);
        assertThat(copy.spec().destination()).isInstanceOfSatisfying(ArtifactDestination.Assigned.class, assigned -> assertThat(assigned.binding()).isEqualTo(BindingKind.BOUND));
        assertThat(copy.spec().retention()).isEqualTo(ArtifactRetention.PINNED);
        assertThat(staged.stat(OWNER, uuid).artifact().state()).as("a copy keeps the staged file").isEqualTo(ArtifactState.READY);
        assertThat(staged.stat(OWNER, uuid).actions()).extracting(StagedAction::state).containsExactly(StagedActionState.SUBMITTED);

        assertThatThrownBy(() -> staged.place(request(uuid, StagedActionKind.COPY, "copy-operation-key-1", "/srv/other.bin"))).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.OPERATION_KEY_CONFLICT));
        StagedPlacementRequest stale = new StagedPlacementRequest(OWNER, uuid, StagedActionKind.COPY, "copy-operation-key-2", targets.linux(), TargetRevision.of("b".repeat(64)),
            new PosixRemotePath("/srv/a.bin"), OverwriteMode.REPLACE, Elevation.NONE);
        assertThatThrownBy(() -> staged.place(stale)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(RequestErrorCode.TARGET_REVISION_CONFLICT));
        assertThat(admission.admitted).hasSize(1);
    }

    @Test
    @DisplayName("RC-B-130 / RC-B-131 / RC-B-132 / D-0035: a move consumes the staged file only when the operation completed with FilePublished of this very content; a completion without it, with another digest, or an unknown operation consumes nothing; remove is busy while an action is open")
    void aMoveConsumesTheStagedFileOnlyOnConfirmedPublication() {
        byte[] bytes = bytes(500, 6);
        ArtifactUuid uuid = stage("move-key-00000000001", bytes);
        staged.place(request(uuid, StagedActionKind.MOVE, "move-operation-key-1", "/srv/m.bin"));
        Digest approved = DIGEST.digest(bytes);

        assertThatThrownBy(() -> staged.remove(OWNER, uuid)).isInstanceOfSatisfying(RequestRefusedException.class,
            e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_BUSY));
        staged.operationSettled(OWNER, uuid, "move-operation-key-1", OperationState.UNKNOWN, new CompletionEvidence.NoEvidence());
        assertThat(staged.stat(OWNER, uuid).artifact().state()).as("an unknown operation keeps the file and the action open").isEqualTo(ArtifactState.READY);
        assertThat(staged.stat(OWNER, uuid).actions().get(0).state()).isEqualTo(StagedActionState.SUBMITTED);

        staged.operationSettled(OWNER, uuid, "move-operation-key-1", OperationState.COMPLETED, new CompletionEvidence.NoEvidence());
        assertThat(staged.stat(OWNER, uuid).artifact().state()).as("a completion without the publication evidence consumes nothing").isEqualTo(ArtifactState.READY);

        ArtifactUuid other = stage("move-key-00000000002", bytes);
        staged.place(request(other, StagedActionKind.MOVE, "move-operation-key-2", "/srv/n.bin"));
        staged.operationSettled(OWNER, other, "move-operation-key-2", OperationState.COMPLETED, new CompletionEvidence.FilePublished(clock.instant(), DIGEST.digest(bytes(1, 1))));
        assertThat(staged.stat(OWNER, other).artifact().state()).as("the evidence of another content consumes nothing").isEqualTo(ArtifactState.READY);

        ArtifactUuid third = stage("move-key-00000000003", bytes);
        staged.place(request(third, StagedActionKind.MOVE, "move-operation-key-3", "/srv/o.bin"));
        staged.operationSettled(OWNER, third, "move-operation-key-3", OperationState.COMPLETED, new CompletionEvidence.FilePublished(clock.instant(), approved));

        ArtifactRecord consumed = staged.stat(OWNER, third).artifact();
        assertThat(consumed.state()).isEqualTo(ArtifactState.CONSUMED);
        assertThat(consumed.consumption()).isEqualTo(new ConsumeState.ConsumedBecause(ConsumeReason.MOVED));
        assertThat(payloads.stored()).doesNotContain(consumed.id());
        assertThat(staged.stat(OWNER, third).actions().get(0).state()).isEqualTo(StagedActionState.SETTLED);
    }

    @Test
    @DisplayName("RC-A-776 / RC-A-777: while a maintenance reservation holds the installation no staged file is begun, appended or sent; after the release it works again")
    void maintenanceRefusesStagedWork() {
        ArtifactUuid uuid = stage("maint-key-00000000001", bytes(100, 1));
        OwnerHash owner = new OwnerHash("a".repeat(64));
        maintenance.reserve(owner);
        try {
            assertThatThrownBy(() -> staged.begin(OWNER, "maint-key-00000000002", new FileName("f.bin"), 5)).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_MAINTENANCE));
            assertThatThrownBy(() -> staged.place(request(uuid, StagedActionKind.COPY, "maint-operation-key-1", "/srv/a.bin"))).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_MAINTENANCE));
            assertThatThrownBy(() -> staged.remove(OWNER, uuid)).isInstanceOfSatisfying(RequestRefusedException.class,
                e -> assertThat(e.code()).isEqualTo(ArtifactErrorCode.ARTIFACT_MAINTENANCE));
        } finally {
            maintenance.release(owner);
        }

        assertThat(staged.begin(OWNER, "maint-key-00000000002", new FileName("f.bin"), 5)).isInstanceOf(StagedBegin.Begun.class);
        assertThat(admission.admitted).isEmpty();
    }

    @Test
    @DisplayName("S3-AR-02: a copy whose bytes the budget cannot hold is answered as a refusal with its numbers, nothing is admitted and no copy is left")
    void aCopyThatTheBudgetRefusesAdmitsNothing() {
        ArtifactUuid uuid = stage("budget-key-0000000001", bytes(5000, 1));
        for (int i = 0; i < 10; i++) {
            reserveFiller();
        }

        StagedPlacement placement = staged.place(request(uuid, StagedActionKind.COPY, "budget-operation-key1", "/srv/a.bin"));

        assertThat(placement).isInstanceOfSatisfying(StagedPlacement.Refused.class, refused -> assertThat(refused.refusal().code()).isEqualTo(ExecutionErrorCode.ARTIFACT_QUOTA));
        assertThat(admission.admitted).isEmpty();
        assertThat(registry.holding()).as("the staged file and the ten fillers").hasSize(11);
    }

    @Test
    @DisplayName("G4: an intake that refuses the upload leaves no copy behind: the copy is removed and the budget is back")
    void aRefusedAdmissionRemovesTheCopy() {
        ArtifactUuid uuid = stage("full-key-00000000001", bytes(300, 1));
        long before = registry.budget().chargedBytes();
        admission.full = true;

        assertThatThrownBy(() -> staged.place(request(uuid, StagedActionKind.COPY, "full-operation-key-1", "/srv/a.bin"))).isInstanceOf(RequestRefusedException.class);

        assertThat(registry.budget().chargedBytes()).isEqualTo(before);
        assertThat(registry.holding()).hasSize(1);
        assertThat(staged.stat(OWNER, uuid).actions()).isEmpty();
    }

    // ---- helpers ----

    private byte[] bytes(int length, int fill) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, (byte) fill);
        return bytes;
    }

    private ArtifactUuid begin(String key, long size) {
        return ((StagedBegin.Begun) staged.begin(OWNER, key, new FileName("f.bin"), size)).uuid();
    }

    /** A staged file that is {@code READY}: begun, one chunk appended, completed. */
    private ArtifactUuid stage(String key, byte[] bytes) {
        ArtifactUuid uuid = begin(key, bytes.length);
        staged.append(OWNER, uuid, 0, bytes, DIGEST.digest(bytes));
        staged.complete(OWNER, uuid);
        return uuid;
    }

    private StagedPlacementRequest request(ArtifactUuid uuid, StagedActionKind kind, String operationKey, String path) {
        return new StagedPlacementRequest(OWNER, uuid, kind, operationKey, targets.linux(), targets.linux().revision(), new PosixRemotePath(path), OverwriteMode.REPLACE,
            Elevation.NONE);
    }

    private void reserveFiller() {
        ArtifactSpec spec = new ArtifactSpec(ArtifactDirection.UPLOAD, new FileName("filler.bin"), 9_500, new ArtifactOrigin.Transfer(),
            new ArtifactDestination.Unassigned(), OverwriteMode.REPLACE, Elevation.NONE, UploadProtocol.UNSPECIFIED, ArtifactRetention.RELEASABLE, Duration.ofMinutes(10));
        assertThat(registry.reserve(spec, clock.instant())).isInstanceOf(ArtifactReservation.Reserved.class);
    }
}
